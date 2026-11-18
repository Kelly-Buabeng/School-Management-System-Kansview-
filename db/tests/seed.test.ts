import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidStudentCode } from '../../packages/shared/src/damm';
import { DEV_MFA, DEV_USERS, seed } from '../seeds/seed.mjs';
import { createDb, one, type TestDb } from './support';

let db: TestDb;
let c: pg.Client;
const keyFile = join(mkdtempSync(join(tmpdir(), 'a-seed-')), 'master.key');
writeFileSync(keyFile, `1:${randomBytes(32).toString('base64')}\nbidx:${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
const opts = { seed: 42, log: () => {}, skipMigrate: true, masterKeyFile: keyFile };

beforeAll(async () => {
  db = await createDb('a_ts');
  await seed(db.url, opts);
  c = await db.client();
}, 180_000);
afterAll(async () => db?.drop());

const count = async (sql: string) => (await one<{ n: number }>(c, `SELECT (${sql})::int AS n`)).n;

describe('seed generator', () => {
  it('creates the expected population', async () => {
    expect(await count(`SELECT count(*) FROM app.students WHERE status = 'active'`)).toBe(1000);
    expect(await count(`SELECT count(DISTINCT l.code) FROM app.enrolments e JOIN app.classes cl ON cl.id = e.class_id JOIN app.levels l ON l.id = cl.level_id WHERE e.end_date IS NULL`)).toBe(13);
    expect(await count(`SELECT count(*) FROM app.enrolments WHERE end_date IS NULL`)).toBe(1000);
    const families = await count(`SELECT count(DISTINCT guardian_id) FROM app.student_guardians WHERE is_primary`);
    expect(families).toBeGreaterThan(550);
    expect(families).toBeLessThan(750);
    expect(await count(`SELECT count(DISTINCT student_id) FROM app.v_sibling_links`)).toBeGreaterThan(300);
    expect(await count(`SELECT count(*) FROM app.staff`)).toBe(45);
    expect(await count(`SELECT count(*) FROM app.academic_years`)).toBe(2);
    expect(await count(`SELECT count(*) FROM app.terms`)).toBe(6);
    const medical = await count(`SELECT count(*) FROM app.student_medical`);
    expect(medical).toBeGreaterThan(60);
    expect(medical).toBeLessThan(150);
    expect(await count(`SELECT count(*) FROM app.student_medical WHERE has_alert`)).toBeGreaterThan(20);
    const roles = (await c.query(`SELECT DISTINCT unnest(roles) AS r FROM app.users ORDER BY 1`)).rows.map((x) => x.r);
    expect(roles).toEqual(['ADMIN', 'BURSAR', 'HEADTEACHER', 'REGISTRAR', 'TEACHER']);
  });

  it('dev passwords verify against the stored argon2id hashes', async () => {
    const u = DEV_USERS[1]!;
    const { password_hash } = await one<{ password_hash: string }>(c, 'SELECT password_hash FROM app.users WHERE username = $1', [u.username]);
    expect(password_hash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(password_hash, u.password)).toBe(true);
  });

  it('works with the API: Argon2 settings, field crypto, TOTP and blind index', async () => {
    const { parseKeyFile, FieldCryptoEngine } = await import('../../apps/api/src/security/field-crypto.service');
    const { verifyTotp, currentTotp, consumeRecoveryCode } = await import('../../apps/api/src/security/totp');
    const { ARGON2_OPTIONS } = await import('../../apps/api/src/security/password-hasher');
    const engine = new FieldCryptoEngine(parseKeyFile((await import('node:fs')).readFileSync(keyFile, 'utf8')));
    const admin = await one<{ password_hash: string; mfa_enabled: boolean; mfa_secret_enc: Buffer; mfa_recovery_codes_hash: string[] }>(c,
      `SELECT password_hash, mfa_enabled, mfa_secret_enc, mfa_recovery_codes_hash FROM app.users WHERE username = 'admin'`);
    expect(admin.password_hash).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}\\$`));
    expect(admin.mfa_enabled).toBe(true);
    const secret = engine.decrypt(admin.mfa_secret_enc);
    expect(secret).toBe(DEV_MFA.admin.secret);
    expect(verifyTotp(currentTotp(secret), secret, null)).not.toBeNull();
    expect(consumeRecoveryCode(DEV_MFA.admin.recoveryCodes[0]!, admin.mfa_recovery_codes_hash)).toHaveLength(2);
    const g = await one<{ ghana_card_enc: Buffer; ghana_card_bidx: Buffer; ghana_card_last4: string }>(c, 'SELECT ghana_card_enc, ghana_card_bidx, ghana_card_last4 FROM app.guardians LIMIT 1');
    const card = engine.decrypt(g.ghana_card_enc);
    expect(card).toMatch(/^GHA-\d{9}-\d$/);
    expect(engine.blindIndex(card).equals(g.ghana_card_bidx)).toBe(true);
    expect(card.replace(/\D/g, '').slice(-4)).toBe(g.ghana_card_last4);
    const m = await one<{ allergies_enc: Buffer | null; chronic_conditions_enc: Buffer | null }>(c, 'SELECT allergies_enc, chronic_conditions_enc FROM app.student_medical WHERE has_alert LIMIT 1');
    expect(engine.decrypt((m.allergies_enc ?? m.chronic_conditions_enc)!).length).toBeGreaterThan(3);
  });

  it("Agent C's LedgerService agrees with the seeded ledger", async () => {
    const { LedgerServiceImpl } = await import('../../apps/api/src/modules/finance/ledger.service');
    const { FinanceStore } = await import('../../apps/api/src/modules/finance/finance-store');
    const kdb = new Kysely<any>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: db.url, max: 2 }) }) });
    try {
      const ledger = new LedgerServiceImpl(kdb as never, new FinanceStore(kdb as never));
      const sample = (await c.query(`
        (SELECT student_id FROM app.mv_student_balances WHERE balance_pesewas > 0 ORDER BY student_id LIMIT 3)
        UNION ALL (SELECT student_id FROM app.mv_student_balances WHERE balance_pesewas < 0 ORDER BY student_id LIMIT 2)
        UNION ALL (SELECT DISTINCT student_id FROM app.payments WHERE status = 'reversed' LIMIT 2)`)).rows.map((x) => x.student_id as string);
      expect(sample.length).toBeGreaterThanOrEqual(5);
      for (const id of sample) {
        const mine = await one<{ b: number }>(c, 'SELECT balance_pesewas::int AS b FROM app.mv_student_balances WHERE student_id = $1', [id]);
        const theirs = await ledger.balance(id);
        expect(theirs.balancePesewas).toBe(mine.b);
        expect(theirs.creditPesewas).toBe(mine.b < 0 ? -mine.b : 0);
      }
    } finally {
      await kdb.destroy();
    }
  });

  it('uses only fake test phone numbers and valid student codes', async () => {
    const phones = (await c.query(`
      SELECT phone_primary AS p FROM app.guardians UNION ALL SELECT phone_secondary FROM app.guardians WHERE phone_secondary IS NOT NULL
      UNION ALL SELECT phone FROM app.staff UNION ALL SELECT phone FROM app.emergency_contacts WHERE phone IS NOT NULL
      UNION ALL SELECT phone FROM app.authorised_pickups WHERE phone IS NOT NULL`)).rows.map((x) => x.p as string);
    expect(phones.length).toBeGreaterThan(1000);
    for (const p of phones) expect(p).toMatch(/^\+233(20|24)000\d{4}$/);
    expect(await count(`SELECT count(*) FROM (SELECT phone_primary FROM app.guardians GROUP BY 1 HAVING count(*) > 1) x`)).toBe(0);
    const codes = (await c.query('SELECT student_code FROM app.students')).rows.map((x) => x.student_code as string);
    for (const code of codes) expect(isValidStudentCode(code)).toBe(true);
  });

  it('ledger balances equal invoices − payments + reversals ± adjustments, and allocations are consistent', async () => {
    const mismatches = await count(`
      WITH exp AS (
        SELECT s.id,
          coalesce((SELECT sum(il.amount_pesewas) FROM app.invoice_lines il JOIN app.invoices i ON i.id = il.invoice_id WHERE i.student_id = s.id AND i.status = 'issued'), 0)
          - coalesce((SELECT sum(amount_pesewas) FROM app.payments p WHERE p.student_id = s.id AND p.status = 'confirmed'), 0)
          - coalesce((SELECT sum(amount_pesewas) FROM app.adjustments a WHERE a.student_id = s.id AND a.status = 'approved' AND a.type <> 'manual_charge'), 0)
          + coalesce((SELECT sum(amount_pesewas) FROM app.adjustments a WHERE a.student_id = s.id AND a.status = 'approved' AND a.type = 'manual_charge'), 0) AS expected
        FROM app.students s)
      SELECT count(*) FROM exp LEFT JOIN app.mv_student_balances b ON b.student_id = exp.id
       WHERE exp.expected <> coalesce((SELECT sum(amount_pesewas) FROM app.ledger_entries le WHERE le.student_id = exp.id), 0)
          OR exp.expected <> b.balance_pesewas`);
    expect(mismatches).toBe(0);
    expect(await count(`SELECT count(*) FROM app.payments p WHERE amount_pesewas * (status = 'confirmed')::int <> (SELECT sum(amount_pesewas) FROM app.payment_allocations a WHERE a.payment_id = p.id)`)).toBe(0);
    expect(await count(`SELECT count(*) FROM app.invoice_lines l WHERE (SELECT coalesce(sum(amount_pesewas), 0) FROM app.payment_allocations a WHERE a.invoice_line_id = l.id) > l.amount_pesewas`)).toBe(0);
    expect(await count(`SELECT count(*) FROM app.invoices i WHERE total_pesewas <> (SELECT sum(amount_pesewas) FROM app.invoice_lines l WHERE l.invoice_id = i.id)`)).toBe(0);
    expect(await count(`SELECT count(*) FROM app.payments WHERE status = 'reversed'`)).toBeGreaterThan(0);
    expect(await count(`SELECT count(DISTINCT method) FROM app.payments`)).toBe(6);
  });

  it('document numbers are gap-free and counters continue after the seed', async () => {
    for (const [table, col, type] of [['app.payments', 'receipt_no', 'receipt'], ['app.invoices', 'invoice_no', 'invoice'], ['app.payment_reversals', 'reversal_no', 'reversal']] as const) {
      const r = await one<{ n: number; mx: number }>(c, `SELECT count(*)::int AS n, max(substr(${col}, 5)::int) AS mx FROM ${table}`);
      expect(r.mx).toBe(r.n);
      const next = await one<{ v: string }>(c, `SELECT app.next_doc_no($1) AS v`, [type]);
      expect(Number(next.v.split('-')[1])).toBe(r.n + 1);
    }
    const { code } = await one<{ code: string }>(c, 'SELECT app.next_student_code(2026) AS code');
    expect(await count(`SELECT count(*) FROM app.students WHERE student_code = '${code}'`)).toBe(0);
  });

  it('is idempotent and deterministic', async () => {
    const before = await count('SELECT count(*) FROM app.students');
    await expect(seed(db.url, opts)).resolves.toEqual({ skipped: true });
    expect(await count('SELECT count(*) FROM app.students')).toBe(before);

    const other = await createDb('a_ts');
    try {
      await seed(other.url, opts);
      const oc = await other.client();
      const q = `SELECT student_code, first_name, last_name, date_of_birth::text FROM app.students ORDER BY student_code`;
      expect((await oc.query(q)).rows).toEqual((await c.query(q)).rows);
      const p = `SELECT receipt_no, amount_pesewas, method FROM app.payments ORDER BY receipt_no`;
      expect((await oc.query(p)).rows).toEqual((await c.query(p)).rows);
    } finally {
      await other.drop();
    }
  }, 180_000);
});
