// Test helpers: isolated, fully migrated database per test file (same approach as apps/api/test/support/test-db.ts).
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../tools/migrate.mjs';

export const ADMIN_URL = process.env.SMS_TEST_DB_ADMIN_URL ?? 'postgres://sms:sms@localhost:5432/postgres';

export interface TestDb {
  url: string;
  name: string;
  client(): Promise<pg.Client>;
  drop(): Promise<void>;
}

const RETRYABLE = new Set([
  '55006', // object_in_use: "source database template… is being accessed by other users"
  '23505', // unique_violation on pg_database (name collision)
  '42P04', // duplicate_database
  '40001', // serialization_failure
  '53300', // too_many_connections (other agents testing on the same server)
  '57P03', // cannot_connect_now
]);

/**
 * Creates an empty database. Safe when many test processes share one server:
 * - names include the process id and 8 random bytes, so they never collide in practice;
 * - TEMPLATE template0 (nobody connects to it), so other sessions on template1 do not block the copy;
 * - retries with jittered backoff on the transient errors above.
 */
async function createEmptyDatabase(prefix: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${prefix}_${process.pid}_${randomBytes(8).toString('hex')}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    admin.on('error', () => {});
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
      return name;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (!code || !RETRYABLE.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt + Math.random() * 200));
    } finally {
      await admin.end().catch(() => {});
    }
  }
  throw lastErr;
}

export async function createDb(prefix = 'a_t'): Promise<TestDb> {
  const name = await createEmptyDatabase(prefix);
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  await migrate(url, { log: () => {} });
  const opened: pg.Client[] = [];
  return {
    url,
    name,
    async client() {
      const c = new pg.Client({ connectionString: url });
      c.on('error', () => {}); // connections are terminated by DROP DATABASE ... WITH (FORCE)
      await c.connect();
      opened.push(c);
      return c;
    },
    async drop() {
      await Promise.all(opened.map((c) => ((c as unknown as { _ending?: boolean })._ending ? undefined : c.end().catch(() => {}))));
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export interface Fixture {
  userId: string;
  approverId: string;
  yearId: string;
  termId: string;
  levelId: string;
  classId: string;
  studentId: string;
  studentCode: string;
  guardianId: string;
  feeItemId: string;
  invoiceLineId: string;
  paymentId: string;
  chargeEntryId: string;
  paymentEntryId: string;
}

export async function one<T = Record<string, unknown>>(c: pg.ClientBase, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected one row, got ${r.rows.length}: ${sql}`);
  return r.rows[0] as T;
}

export async function insertStudent(c: pg.ClientBase, classId: string, first = 'Kwame', last = 'Mensah'): Promise<{ id: string; code: string }> {
  const { code } = await one<{ code: string }>(c, `SELECT app.next_student_code(2026) AS code`);
  const seq = Number(code.split('-')[2]);
  const s = await one<{ id: string }>(
    c,
    `INSERT INTO app.students (student_code, admission_year, admission_seq, first_name, last_name, date_of_birth, gender, admission_class_id)
     VALUES ($1, 2026, $2, $3, $4, '2018-03-14', 'male', $5) RETURNING id`,
    [code, seq, first, last, classId],
  );
  return { id: s.id, code };
}

/** Minimal, consistent graph: users, year, term, class, student, guardian, invoice, payment, ledger entries. */
export async function createFixture(c: pg.ClientBase): Promise<Fixture> {
  const userId = (await one<{ id: string }>(c, `INSERT INTO app.users (username, full_name, password_hash, roles) VALUES ('bursar1', 'Ama Bursar', 'x', '{BURSAR}') RETURNING id`)).id;
  const approverId = (await one<{ id: string }>(c, `INSERT INTO app.users (username, full_name, password_hash, roles) VALUES ('admin1', 'Kofi Admin', 'x', '{ADMIN}') RETURNING id`)).id;
  const yearId = (await one<{ id: string }>(c, `INSERT INTO app.academic_years (name, start_date, end_date, status) VALUES ('2026/2027', '2026-09-07', '2027-07-30', 'current') RETURNING id`)).id;
  const termId = (await one<{ id: string }>(c, `INSERT INTO app.terms (academic_year_id, number, name, start_date, end_date, status) VALUES ($1, 1, 'Term 1', '2026-09-07', '2026-12-18', 'current') RETURNING id`, [yearId])).id;
  const levelId = (await one<{ id: string }>(c, `SELECT id FROM app.levels WHERE code = 'P3'`)).id;
  const classId = (await one<{ id: string }>(c, `INSERT INTO app.classes (academic_year_id, level_id, stream, display_name, capacity) VALUES ($1, $2, 'A', 'Primary 3A', 40) RETURNING id`, [yearId, levelId])).id;
  const student = await insertStudent(c, classId);
  const guardianId = (await one<{ id: string }>(c, `INSERT INTO app.guardians (first_name, last_name, phone_primary) VALUES ('Akosua', 'Mensah', '+233240000101') RETURNING id`)).id;
  await c.query(`INSERT INTO app.student_guardians (student_id, guardian_id, relationship, is_primary, is_fee_payer) VALUES ($1, $2, 'mother', true, true)`, [student.id, guardianId]);
  const feeItemId = (await one<{ id: string }>(c, `INSERT INTO app.fee_items (code, name, category) VALUES ('TUITION', 'Tuition', 'tuition') RETURNING id`)).id;
  const { invoice_no } = await one<{ invoice_no: string }>(c, `SELECT app.next_doc_no('invoice') AS invoice_no`);
  const invoiceId = (await one<{ id: string }>(c, `INSERT INTO app.invoices (invoice_no, student_id, term_id, class_id, total_pesewas) VALUES ($1, $2, $3, $4, 150000) RETURNING id`, [invoice_no, student.id, termId, classId])).id;
  const invoiceLineId = (await one<{ id: string }>(c, `INSERT INTO app.invoice_lines (invoice_id, fee_item_id, description, amount_pesewas) VALUES ($1, $2, 'Tuition', 150000) RETURNING id`, [invoiceId, feeItemId])).id;
  const chargeEntryId = (await one<{ id: string }>(c, `INSERT INTO app.ledger_entries (student_id, term_id, entry_type, amount_pesewas, invoice_line_id, description, posted_by) VALUES ($1, $2, 'invoice_charge', 150000, $3, 'Tuition Term 1', $4) RETURNING id`, [student.id, termId, invoiceLineId, userId])).id;
  const { receipt_no } = await one<{ receipt_no: string }>(c, `SELECT app.next_doc_no('receipt') AS receipt_no`);
  const paymentId = (await one<{ id: string }>(c, `INSERT INTO app.payments (receipt_no, student_id, payer_guardian_id, payer_name, amount_pesewas, method, reference_no, recorded_by, idempotency_key) VALUES ($1, $2, $3, 'Akosua Mensah', 50000, 'momo_mtn', ' ab123 ', $4, $5) RETURNING id`, [receipt_no, student.id, guardianId, userId, randomUUID()])).id;
  await c.query(`INSERT INTO app.payment_allocations (payment_id, invoice_line_id, amount_pesewas, allocation_batch_id) VALUES ($1, $2, 50000, $3)`, [paymentId, invoiceLineId, randomUUID()]);
  const paymentEntryId = (await one<{ id: string }>(c, `INSERT INTO app.ledger_entries (student_id, term_id, entry_type, amount_pesewas, payment_id, description, posted_by) VALUES ($1, $2, 'payment', -50000, $3, 'Payment', $4) RETURNING id`, [student.id, termId, paymentId, userId])).id;
  return { userId, approverId, yearId, termId, levelId, classId, studentId: student.id, studentCode: student.code, guardianId, feeItemId, invoiceLineId, paymentId, chargeEntryId, paymentEntryId };
}
