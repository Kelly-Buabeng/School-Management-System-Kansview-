/**
 * Writers used by the commit, one per import type. Each runs inside the caller's batch transaction.
 *
 * - Students + guardians go through ImportTarget (Agent B), the same rules as manual admission.
 * - Opening balances go through Agent C's FinanceStore (lock + append-only ledger insert).
 * - Staff have no cross-agent writer yet, so they are inserted here. TEMPORARY until CR-0007 is decided
 *   (ImportTarget.upsertStaff); follows docs/contracts/schema.md and only INSERTs.
 */
import { sql } from 'kysely';
import { AppError } from '../../common/app-error';
import type { Tx } from '../../common/db/database.module';
import type { ImportStudentRow, ImportTarget } from '../../common/contracts';
import type { FinanceStore } from '../finance/finance-store';
import type { NormalisedBalance, NormalisedStaff, NormalisedStudent } from './row-validation';

export function toImportStudentRow(s: NormalisedStudent, guardianIdsByPhone: Map<string, string>): ImportStudentRow {
  if (!s.classId) throw new Error('row has no class id');
  return {
    firstName: s.firstName,
    ...(s.middleNames ? { middleNames: s.middleNames } : {}),
    lastName: s.lastName,
    ...(s.preferredName ? { preferredName: s.preferredName } : {}),
    dateOfBirth: s.dateOfBirth,
    gender: s.gender,
    admissionDate: s.admissionDate,
    admissionYear: Number(s.admissionDate.slice(0, 4)),
    classId: s.classId,
    ...(s.previousSchool ? { previousSchool: s.previousSchool } : {}),
    ...(s.homeAddress ? { homeAddress: s.homeAddress } : {}),
    ...(s.nationality ? { nationality: s.nationality } : {}),
    ...(s.religion ? { religion: s.religion } : {}),
    ...(s.medical
      ? {
          medical: {
            ...(s.medical.alertSummary ? { alertSummary: s.medical.alertSummary } : {}),
            ...(s.medical.allergies ? { allergies: s.medical.allergies } : {}),
            ...(s.medical.bloodGroup && /^(A|B|AB|O)[+-]$/.test(s.medical.bloodGroup) ? { bloodGroup: s.medical.bloodGroup } : {}),
          },
        }
      : {}),
    guardians: s.guardians.map((g) => {
      const existing = guardianIdsByPhone.get(g.phonePrimary);
      return {
        ...(existing ? { existingGuardianId: existing } : {}),
        firstName: g.firstName,
        lastName: g.lastName,
        relationship: g.relationship,
        phonePrimary: g.phonePrimary,
        ...(g.phoneSecondary ? { phoneSecondary: g.phoneSecondary } : {}),
        ...(g.whatsappNumber ? { whatsappNumber: g.whatsappNumber } : {}),
        ...(g.email ? { email: g.email } : {}),
        ...(g.occupation ? { occupation: g.occupation } : {}),
        isPrimary: g.isPrimary,
        isFeePayer: g.isFeePayer,
        canPickUp: g.canPickUp,
      };
    }),
    ...(s.legacyId ? { legacyId: s.legacyId } : {}),
  };
}

export async function writeStudent(tx: Tx, target: ImportTarget, s: NormalisedStudent, guardianIdsByPhone: Map<string, string>, actorId: string): Promise<{ studentId: string; guardianIds: string[] }> {
  const res = await target.upsertStudentWithGuardians(toImportStudentRow(s, guardianIdsByPhone), tx, actorId);
  s.guardians.forEach((g, i) => {
    const id = res.guardianIds[i];
    if (id) guardianIdsByPhone.set(g.phonePrimary, id);
  });
  return { studentId: res.studentId, guardianIds: res.guardianIds };
}

/** TEMPORARY (CR-0007): inserts a staff record + emergency contact. Staff ID generated as STF-0001… when the file has none. */
export async function writeStaff(tx: Tx, s: NormalisedStaff, actorId: string): Promise<string> {
  let code = s.staffCode;
  if (!code) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('sms.staff_code'))`.execute(tx);
    const r = await sql<{ n: number }>`
      SELECT coalesce(max(substring(staff_code FROM '^STF-([0-9]+)$')::int), 0) + 1 AS n FROM staff WHERE staff_code ~ '^STF-[0-9]+$'`.execute(tx);
    code = `STF-${String(r.rows[0]!.n).padStart(4, '0')}`;
  }
  const row = await tx
    .insertInto('staff')
    .values({
      staff_code: code,
      first_name: s.firstName,
      last_name: s.lastName,
      gender: s.gender,
      date_of_birth: s.dateOfBirth,
      phone: s.phone,
      email: s.email,
      address: s.address,
      staff_type: s.staffType,
      job_title: s.jobTitle,
      employment_date: s.employmentDate,
      created_by: actorId,
      updated_by: actorId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (s.emergencyContact) {
    await tx
      .insertInto('staff_emergency_contacts')
      .values({ staff_id: row.id, priority: 1, name: s.emergencyContact.name, relationship: s.emergencyContact.relationship, phone: s.emergencyContact.phone, created_by: actorId, updated_by: actorId })
      .execute();
  }
  return row.id;
}

/**
 * Posts one `opening_balance` ledger entry through Agent C's FinanceStore (same per-student lock and append-only
 * insert that payments and adjustments use). Signed pesewas: + owed by the family, − credit. Zero posts nothing.
 * At most one opening balance per student: checked under the student's finance lock, so two commits cannot race.
 */
export async function postOpeningBalance(tx: Tx, finance: FinanceStore, b: NormalisedBalance, actorId: string): Promise<{ entryId: string } | null> {
  if (!b.studentId || !b.termId) throw new Error('balance row not resolved');
  if (b.amountPesewas === 0) return null;
  await finance.lockStudent(tx, b.studentId);
  const existing = await tx.selectFrom('ledger_entries').select('id').where('student_id', '=', b.studentId).where('entry_type', '=', 'opening_balance').executeTakeFirst();
  if (existing) throw new AppError(409, 'IMPORT_INVALID_STATE', 'This student already has an opening balance', 'To change it, record an adjustment in Finance instead.');
  const description = `Opening balance from old records${b.note ? `: ${b.note}` : ''}`.slice(0, 500);
  const [entry] = await finance.postLedger(tx, [{ studentId: b.studentId, termId: b.termId, entryType: 'opening_balance', amountPesewas: b.amountPesewas, description, postedBy: actorId }]);
  return { entryId: entry!.id };
}
