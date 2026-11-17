import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatStudentCode, isValidStudentCode } from '../../packages/shared/src/damm';
import { migrate } from '../tools/migrate.mjs';
import { createDb, one, type TestDb } from './support';

let db: TestDb;
let c: pg.Client;

beforeAll(async () => {
  db = await createDb();
  c = await db.client();
});
afterAll(async () => db?.drop());

describe('migrations', () => {
  it('apply from an empty database and record every file', async () => {
    const files = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f));
    const { n } = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM public.schema_migrations');
    expect(n).toBe(files.length);
    const { v } = await one<{ v: string }>(c, `SELECT current_setting('server_version_num') AS v`);
    expect(Number(v)).toBeGreaterThanOrEqual(160000);
  });

  it('is idempotent when run again', async () => {
    await expect(migrate(db.url, { log: () => {} })).resolves.toBeUndefined();
  });

  it('creates the three schemas and resolves app tables unqualified on new connections', async () => {
    const r = await c.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('app','audit','import') ORDER BY 1`);
    expect(r.rows.map((x) => x.nspname)).toEqual(['app', 'audit', 'import']);
    const { n } = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM levels');
    expect(n).toBe(13);
  });

  it('app.uuid_v7 produces time-ordered version-7 uuids', async () => {
    const r = await c.query('SELECT app.uuid_v7()::text AS u FROM generate_series(1, 50)');
    const ids = r.rows.map((x) => x.u as string);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(50);
    expect(ids[0]!.slice(0, 8) <= ids[49]!.slice(0, 8)).toBe(true);
  });

  it('seeds reference data', async () => {
    const p = await one<{ school_code: string; timezone: string }>(c, 'SELECT school_code, timezone FROM app.school_profile');
    expect(p).toEqual({ school_code: 'KSV', timezone: 'Africa/Accra' });
    const chain = await c.query(`
      WITH RECURSIVE l AS (
        SELECT id, code, next_level_id, is_final_level FROM app.levels WHERE code = 'CRECHE'
        UNION ALL SELECT n.id, n.code, n.next_level_id, n.is_final_level FROM app.levels n JOIN l ON n.id = l.next_level_id)
      SELECT code, is_final_level FROM l`);
    expect(chain.rows.map((x) => x.code)).toEqual(['CRECHE', 'NURSERY', 'KG1', 'KG2', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'JHS1', 'JHS2', 'JHS3']);
    expect(chain.rows.at(-1)!.is_final_level).toBe(true);
    const dc = await c.query('SELECT doc_type, prefix FROM app.doc_counters ORDER BY doc_type');
    expect(dc.rows).toEqual([
      { doc_type: 'invoice', prefix: 'INV' },
      { doc_type: 'receipt', prefix: 'RCP' },
      { doc_type: 'reversal', prefix: 'REV' },
      { doc_type: 'transfer_letter', prefix: 'TL' },
    ]);
    const { n } = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM app.grading_bands');
    expect(n).toBe(9);
    const w = await one(c, 'SELECT class_score_weight, exam_score_weight FROM app.assessment_config WHERE level_id IS NULL');
    expect(w).toEqual({ class_score_weight: 30, exam_score_weight: 70 });
    const t = await c.query('SELECT code FROM app.message_templates ORDER BY code');
    expect(t.rows.map((x) => x.code)).toEqual(['absence_alert', 'announcement', 'closure_notice', 'emergency', 'fee_reminder']);
    const s = await one<{ value: unknown }>(c, `SELECT value FROM app.settings WHERE key = 'promotion.block_on_arrears'`);
    expect(s.value).toBe('warn');
  });

  it('grading bands cannot overlap', async () => {
    const { id } = await one<{ id: string }>(c, 'SELECT id FROM app.grading_scales WHERE is_default');
    await expect(c.query(`INSERT INTO app.grading_bands (grading_scale_id, min_score, max_score, grade) VALUES ($1, 75, 85, 'X')`, [id]))
      .rejects.toThrow(/grading_bands_no_overlap/);
  });

  it('damm check digit and next_student_code match packages/shared', async () => {
    const r = await c.query(`SELECT d, app.damm_check_digit(d) AS chk FROM unnest(ARRAY['2600417','2500001','0099999','572']) AS d`);
    const { dammCheckDigit } = await import('../../packages/shared/src/damm');
    for (const row of r.rows) expect(row.chk).toBe(dammCheckDigit(row.d));
    const { code } = await one<{ code: string }>(c, 'SELECT app.next_student_code(2026) AS code');
    expect(code).toBe(formatStudentCode('KSV', 2026, 1));
    const { code: code2 } = await one<{ code: string }>(c, 'SELECT app.next_student_code(2026) AS code');
    expect(code2).toBe(formatStudentCode('KSV', 2026, 2));
    const { code: code3 } = await one<{ code: string }>(c, 'SELECT app.next_student_code(2025) AS code');
    expect(code3).toBe(formatStudentCode('KSV', 2025, 1));
    expect(isValidStudentCode(code3)).toBe(true);
  });

  it('next_doc_no formats with prefix and padding and rejects unknown types', async () => {
    const { n } = await one<{ n: string }>(c, `SELECT app.next_doc_no('transfer_letter') AS n`);
    expect(n).toBe('TL-000001');
    await expect(c.query(`SELECT app.next_doc_no('nope')`)).rejects.toThrow(/Unknown document type/);
  });

  it('creates roles and the finance/audit grant policy', async () => {
    const roles = await c.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('sms_app','sms_audit_writer','sms_readonly') ORDER BY 1`);
    expect(roles.rows.map((x) => x.rolname)).toEqual(['sms_app', 'sms_audit_writer', 'sms_readonly']);
    const priv = async (role: string, table: string, p: string) =>
      (await one<{ ok: boolean }>(c, 'SELECT has_table_privilege($1, $2, $3) AS ok', [role, table, p])).ok;
    for (const t of ['app.ledger_entries', 'app.payment_allocations', 'app.invoice_lines', 'audit.events']) {
      expect(await priv('sms_app', t, 'INSERT')).toBe(true);
      expect(await priv('sms_app', t, 'SELECT')).toBe(true);
      expect(await priv('sms_app', t, 'UPDATE')).toBe(false);
      expect(await priv('sms_app', t, 'DELETE')).toBe(false);
    }
    expect(await priv('sms_app', 'app.payments', 'UPDATE')).toBe(false);
    expect((await one<{ ok: boolean }>(c, `SELECT has_column_privilege('sms_app', 'app.payments', 'status', 'UPDATE') AS ok`)).ok).toBe(true);
    expect((await one<{ ok: boolean }>(c, `SELECT has_column_privilege('sms_app', 'app.payments', 'amount_pesewas', 'UPDATE') AS ok`)).ok).toBe(false);
    expect(await priv('sms_app', 'app.students', 'DELETE')).toBe(false);
    expect(await priv('sms_app', 'app.students', 'UPDATE')).toBe(true);
    expect(await priv('sms_audit_writer', 'audit.events', 'INSERT')).toBe(true);
    expect(await priv('sms_audit_writer', 'audit.events', 'UPDATE')).toBe(false);
    expect(await priv('sms_readonly', 'app.ledger_entries', 'SELECT')).toBe(true);
    expect(await priv('sms_readonly', 'app.ledger_entries', 'INSERT')).toBe(false);
  });
});

describe('concurrent migrations on the same server', () => {
  it('several fresh databases migrate in parallel (role creation is race-safe)', async () => {
    const dbs = await Promise.all(Array.from({ length: 4 }, () => createDb('a_tp')));
    await Promise.all(dbs.map((d) => d.drop()));
    expect(dbs).toHaveLength(4);
  });
});
