import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createFixture, insertStudent, one, type Fixture, type TestDb } from './support';

let db: TestDb;
let c: pg.Client;
let f: Fixture;

beforeAll(async () => {
  db = await createDb();
  c = await db.client();
  f = await createFixture(c);
});
afterAll(async () => db?.drop());

/** Runs fn inside a transaction that is always rolled back, optionally as another role. */
async function attempt(fn: () => Promise<unknown>, role?: string) {
  await c.query('BEGIN');
  try {
    if (role) await c.query(`SET LOCAL ROLE ${role}`);
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

describe('append-only tables', () => {
  it('UPDATE and DELETE on ledger_entries fail', async () => {
    await expect(attempt(() => c.query('UPDATE app.ledger_entries SET description = $1 WHERE id = $2', ['x', f.chargeEntryId]))).rejects.toThrow(/append-only/);
    await expect(attempt(() => c.query('DELETE FROM app.ledger_entries WHERE id = $1', [f.chargeEntryId]))).rejects.toThrow(/append-only/);
    await expect(attempt(() => c.query('TRUNCATE app.ledger_entries CASCADE'))).rejects.toThrow(/append-only/);
  });

  it('sms_app has no UPDATE/DELETE privilege on ledger_entries', async () => {
    await expect(attempt(() => c.query('UPDATE app.ledger_entries SET description = $1 WHERE id = $2', ['x', f.chargeEntryId]), 'sms_app')).rejects.toThrow(/permission denied/);
    await expect(attempt(() => c.query('DELETE FROM app.ledger_entries WHERE id = $1', [f.chargeEntryId]), 'sms_app')).rejects.toThrow(/permission denied/);
  });

  it('UPDATE and DELETE on audit.events fail', async () => {
    const { id } = await one<{ id: number }>(c, `INSERT INTO audit.events (action, entity_type, entity_id) VALUES ('create', 'student', $1) RETURNING id`, [f.studentId]);
    await expect(attempt(() => c.query(`UPDATE audit.events SET action = 'view' WHERE id = $1`, [id]))).rejects.toThrow(/append-only/);
    await expect(attempt(() => c.query('DELETE FROM audit.events WHERE id = $1', [id]))).rejects.toThrow(/append-only/);
    await expect(attempt(() => c.query(`UPDATE audit.events SET action = 'view' WHERE id = $1`, [id]), 'sms_app')).rejects.toThrow(/permission denied/);
  });

  it('payment_allocations, invoice_lines, status history and contact logs are append-only', async () => {
    await expect(attempt(() => c.query('UPDATE app.payment_allocations SET amount_pesewas = 1'))).rejects.toThrow(/append-only/);
    await expect(attempt(() => c.query('UPDATE app.invoice_lines SET amount_pesewas = 1'))).rejects.toThrow(/append-only/);
    await c.query(`INSERT INTO app.student_status_history (student_id, from_status, to_status, source) VALUES ($1, NULL, 'active', 'admission')`, [f.studentId]);
    await expect(attempt(() => c.query('DELETE FROM app.student_status_history'))).rejects.toThrow(/append-only/);
    await c.query(`INSERT INTO app.emergency_contact_logs (student_id, phone_called, outcome, contacted_by) VALUES ($1, '+233240000101', 'reached', $2)`, [f.studentId, f.userId]);
    await expect(attempt(() => c.query(`UPDATE app.emergency_contact_logs SET outcome = 'no_answer'`))).rejects.toThrow(/append-only/);
  });

  it('a reversal must negate the original and can only happen once', async () => {
    await expect(attempt(() => c.query(
      `INSERT INTO app.ledger_entries (student_id, entry_type, amount_pesewas, reverses_entry_id, description) VALUES ($1, 'reversal', 49999, $2, 'bad')`,
      [f.studentId, f.paymentEntryId]))).rejects.toThrow(/negate/);
    await attempt(async () => {
      await c.query(`INSERT INTO app.ledger_entries (student_id, entry_type, amount_pesewas, reverses_entry_id, description) VALUES ($1, 'reversal', 50000, $2, 'ok')`, [f.studentId, f.paymentEntryId]);
      await expect(c.query(`INSERT INTO app.ledger_entries (student_id, entry_type, amount_pesewas, reverses_entry_id, description) VALUES ($1, 'reversal', 50000, $2, 'twice')`, [f.studentId, f.paymentEntryId]))
        .rejects.toThrow(/reverses_entry_id/);
    });
  });
});

describe('payment status guard', () => {
  it('normalises reference_key', async () => {
    const { reference_key } = await one<{ reference_key: string }>(c, 'SELECT reference_key FROM app.payments WHERE id = $1', [f.paymentId]);
    expect(reference_key).toBe('momo_mtn:AB123');
  });

  it('rejects edits to amount or other fields', async () => {
    await expect(attempt(() => c.query('UPDATE app.payments SET amount_pesewas = 1 WHERE id = $1', [f.paymentId]))).rejects.toThrow(/only confirmed → reversed/);
    await expect(attempt(() => c.query(`UPDATE app.payments SET status = 'reversed', reversal_reason = 'x', notes = 'sneaky' WHERE id = $1`, [f.paymentId]))).rejects.toThrow(/only confirmed → reversed/);
    await expect(attempt(() => c.query('DELETE FROM app.payments WHERE id = $1', [f.paymentId]))).rejects.toThrow(/append-only/);
  });

  it('sms_app cannot update amount (column privilege)', async () => {
    await expect(attempt(() => c.query('UPDATE app.payments SET amount_pesewas = 1 WHERE id = $1', [f.paymentId]), 'sms_app')).rejects.toThrow(/permission denied/);
  });

  it('allows confirmed → reversed once, never back', async () => {
    await attempt(async () => {
      const r = await c.query(`UPDATE app.payments SET status = 'reversed', reversal_reason = 'Wrong student' WHERE id = $1 RETURNING reversed_at, version`, [f.paymentId]);
      expect(r.rows[0].reversed_at).toBeInstanceOf(Date);
      expect(r.rows[0].version).toBe(2);
      await expect(c.query(`UPDATE app.payments SET status = 'confirmed' WHERE id = $1`, [f.paymentId])).rejects.toThrow(/only confirmed → reversed/);
    });
  });

  it('sms_app can reverse via mark_payment_reversed', async () => {
    await attempt(async () => {
      await c.query('SELECT app.mark_payment_reversed($1, $2, $3)', [f.paymentId, f.userId, 'Duplicate']);
      const { status } = await one<{ status: string }>(c, 'SELECT status FROM app.payments WHERE id = $1', [f.paymentId]);
      expect(status).toBe('reversed');
      await expect(c.query('SELECT app.mark_payment_reversed($1, $2, $3)', [f.paymentId, f.userId, 'again'])).rejects.toThrow(/already reversed/);
    }, 'sms_app');
  });

  it('receipt numbers and idempotency keys are unique', async () => {
    const { receipt_no } = await one<{ receipt_no: string }>(c, 'SELECT receipt_no FROM app.payments WHERE id = $1', [f.paymentId]);
    await expect(attempt(() => c.query(
      `INSERT INTO app.payments (receipt_no, student_id, payer_name, amount_pesewas, method, recorded_by, idempotency_key) VALUES ($1, $2, 'X', 100, 'cash', $3, $4)`,
      [receipt_no, f.studentId, f.userId, randomUUID()]))).rejects.toThrow(/payments_receipt_no_key/);
  });
});

describe('students', () => {
  it('student_code cannot change; other edits work and bump version', async () => {
    await expect(attempt(() => c.query(`UPDATE app.students SET student_code = 'KSV-26-00099-0' WHERE id = $1`, [f.studentId]))).rejects.toThrow(/permanent/);
    await expect(attempt(() => c.query('UPDATE app.students SET admission_seq = 99 WHERE id = $1', [f.studentId]))).rejects.toThrow(/permanent/);
    await attempt(async () => {
      const r = await c.query(`UPDATE app.students SET preferred_name = 'Kay' WHERE id = $1 RETURNING version, updated_at > created_at AS touched`, [f.studentId]);
      expect(r.rows[0].version).toBe(2);
    });
  });

  it('rejects a student code with a bad check digit', async () => {
    await expect(attempt(() => c.query(
      `INSERT INTO app.students (student_code, admission_year, admission_seq, first_name, last_name, date_of_birth, gender) VALUES ('KSV-26-00500-1', 2026, 500, 'A', 'B', '2018-01-01', 'female')`,
    ))).rejects.toThrow(/students_student_code_valid|students_code_matches_seq/);
  });

  it('school_code is locked once students exist', async () => {
    await expect(attempt(() => c.query(`UPDATE app.school_profile SET school_code = 'ABC'`))).rejects.toThrow(/cannot be changed/);
    await attempt(() => c.query(`UPDATE app.school_profile SET name = 'Kansview Prep'`));
  });

  it('full-text and trigram search find a student', async () => {
    const r = await c.query(`SELECT id FROM app.students WHERE search_vector @@ plainto_tsquery('simple', 'kwame mensah')`);
    expect(r.rows.map((x) => x.id)).toContain(f.studentId);
    const t = await c.query(`SELECT id FROM app.students WHERE lower(first_name || ' ' || coalesce(middle_names || ' ', '') || last_name) % 'kwame mensa'`);
    expect(t.rows.map((x) => x.id)).toContain(f.studentId);
  });

  it('one open enrolment per student and one primary guardian', async () => {
    await c.query(`INSERT INTO app.enrolments (student_id, class_id, academic_year_id, start_date, roll_number) VALUES ($1, $2, $3, '2026-09-07', 1)`, [f.studentId, f.classId, f.yearId]);
    await expect(attempt(() => c.query(`INSERT INTO app.enrolments (student_id, class_id, academic_year_id, start_date) VALUES ($1, $2, $3, '2026-09-08')`, [f.studentId, f.classId, f.yearId])))
      .rejects.toThrow(/enrolments_one_open_per_student/);
    const g2 = await one<{ id: string }>(c, `INSERT INTO app.guardians (first_name, last_name, phone_primary) VALUES ('Yaw', 'Mensah', '+233200000102') RETURNING id`);
    await expect(attempt(() => c.query(`INSERT INTO app.student_guardians (student_id, guardian_id, relationship, is_primary) VALUES ($1, $2, 'father', true)`, [f.studentId, g2.id])))
      .rejects.toThrow(/student_guardians_one_primary/);
  });

  it('adjustments enforce maker-checker', async () => {
    await expect(attempt(() => c.query(
      `INSERT INTO app.adjustments (student_id, type, amount_pesewas, reason, status, requested_by, approved_by, approved_at) VALUES ($1, 'discount', 100, 'x', 'approved', $2, $2, now())`,
      [f.studentId, f.userId]))).rejects.toThrow(/adjustments_maker_checker/);
  });

  it('active fee structures are immutable', async () => {
    await attempt(async () => {
      const fs = await one<{ id: string }>(c, `INSERT INTO app.fee_structures (academic_year_id, term_id, level_id, name) VALUES ($1, $2, $3, 'P3 T1') RETURNING id`, [f.yearId, f.termId, f.levelId]);
      await c.query('INSERT INTO app.fee_structure_lines (fee_structure_id, fee_item_id, amount_pesewas) VALUES ($1, $2, 150000)', [fs.id, f.feeItemId]);
      await c.query(`UPDATE app.fee_structures SET status = 'active', activated_at = now() WHERE id = $1`, [fs.id]);
      await expect(c.query('UPDATE app.fee_structure_lines SET amount_pesewas = 1 WHERE fee_structure_id = $1', [fs.id])).rejects.toThrow(/cannot be changed/);
    });
  });
});

describe('payment reversals (CR-0003)', () => {
  it('enforces maker-checker, one active reversal per payment, and sms_app column grants', async () => {
    await expect(attempt(() => c.query(
      `INSERT INTO app.payment_reversals (payment_id, reason, requested_by, approved_by, status) VALUES ($1, 'Wrong student', $2, $2, 'approved')`,
      [f.paymentId, f.userId]))).rejects.toThrow(/payment_reversals_maker_checker/);
    await attempt(async () => {
      await c.query(`INSERT INTO app.payment_reversals (payment_id, reason, requested_by) VALUES ($1, 'Wrong student', $2)`, [f.paymentId, f.userId]);
      await expect(c.query(`INSERT INTO app.payment_reversals (payment_id, reason, requested_by) VALUES ($1, 'Again please', $2)`, [f.paymentId, f.userId]))
        .rejects.toThrow(/payment_reversals_one_active/);
    }, 'sms_app');
    await attempt(async () => {
      const { id } = await one<{ id: string }>(c, `INSERT INTO app.payment_reversals (payment_id, reason, requested_by) VALUES ($1, 'Wrong student', $2) RETURNING id`, [f.paymentId, f.userId]);
      await c.query(`UPDATE app.payment_reversals SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, f.approverId]);
      await expect(c.query(`UPDATE app.payment_reversals SET reason = 'changed reason' WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
    }, 'sms_app');
    await expect(attempt(() => c.query(`INSERT INTO app.payment_reversals (payment_id, reason, requested_by) VALUES ($1, 'no', $2)`, [f.paymentId, f.userId])))
      .rejects.toThrow(/check/);
  });
});

describe('views', () => {
  it('v_sibling_links derives siblings from shared guardians', async () => {
    const b = await insertStudent(c, f.classId, 'Esi', 'Mensah');
    const other = await insertStudent(c, f.classId, 'Yaw', 'Owusu');
    await c.query(`INSERT INTO app.student_guardians (student_id, guardian_id, relationship, is_primary) VALUES ($1, $2, 'mother', true)`, [b.id, f.guardianId]);
    const r = await c.query('SELECT student_id, sibling_student_id, via_guardian_ids FROM app.v_sibling_links WHERE student_id = ANY($1) ORDER BY student_id', [[f.studentId, b.id, other.id]]);
    expect(r.rows).toEqual([
      { student_id: f.studentId, sibling_student_id: b.id, via_guardian_ids: [f.guardianId] },
      { student_id: b.id, sibling_student_id: f.studentId, via_guardian_ids: [f.guardianId] },
    ].sort((x, y) => (x.student_id < y.student_id ? -1 : 1)));
  });

  it('mv_student_balances refreshes concurrently with correct balances', async () => {
    await c.query('SELECT app.refresh_student_balances()');
    const r = await one<{ balance_pesewas: string; oldest_unpaid_term_id: string }>(c, 'SELECT balance_pesewas, oldest_unpaid_term_id FROM app.mv_student_balances WHERE student_id = $1', [f.studentId]);
    expect(Number(r.balance_pesewas)).toBe(100000);
    expect(r.oldest_unpaid_term_id).toBe(f.termId);
  });
});
