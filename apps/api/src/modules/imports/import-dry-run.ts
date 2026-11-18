/**
 * Dry run: pure row validation (row-validation.ts) plus checks against the database.
 * Writes nothing; the caller stores the result in import.rows.
 */
import type { Kysely } from 'kysely';
import type { DB } from '@sms/db-types';
import { formatCedis } from '@sms/shared';
import type { RawRow } from './file-reader';
import type { ImportType } from './import-columns';
import { findBalanceStudents, findExistingStudents, findGuardiansByPhone, findStaff, studentsWithOpeningBalance, type DuplicateCandidate } from './import-lookups';
import { nameSimilarity } from './normalise';
import {
  statusFor, validateRows, type NormalisedBalance, type NormalisedStaff, type NormalisedStudent, type RowMessage, type RowStatus, type ValidationContext,
} from './row-validation';

export interface Resolution {
  action: 'link_existing' | 'create_new' | 'skip';
  existingId?: string;
}

/** Shape stored in import.rows.normalised: the normalised row plus dry-run findings and the user's decision. */
export type StoredNormalised = (NormalisedStudent | NormalisedStaff | NormalisedBalance) & {
  duplicates?: DuplicateCandidate[] | Array<{ staffId: string; name: string; code: string; reason: string }>;
  resolution?: Resolution | null;
};

export interface DryRunRow {
  rowNumber: number;
  status: RowStatus;
  messages: RowMessage[];
  normalised: StoredNormalised | null;
}

export async function dryRun(db: Kysely<DB>, type: ImportType, rows: RawRow[], mapping: Record<string, string>, ctx: ValidationContext): Promise<DryRunRow[]> {
  const outcomes = validateRows(type, rows, mapping, ctx);
  const dupes = new Map<number, StoredNormalised['duplicates']>();

  if (type === 'students_guardians') {
    const students = outcomes.filter((o) => o.normalised).map((o) => ({ o, s: o.normalised as NormalisedStudent }));
    const existing = await findExistingStudents(
      db,
      students.map(({ o, s }) => ({
        rowNumber: o.rowNumber,
        fullName: [s.firstName, s.middleNames, s.lastName].filter(Boolean).join(' '),
        dateOfBirth: s.dateOfBirth,
        phones: s.guardians.map((g) => g.phonePrimary),
        legacyId: s.legacyId,
      })),
    );
    const guardians = await findGuardiansByPhone(db, students.flatMap(({ s }) => s.guardians.map((g) => g.phonePrimary)));
    for (const { o, s } of students) {
      const cands = existing.get(o.rowNumber);
      if (cands?.length) {
        dupes.set(o.rowNumber, cands);
        const list = cands.map((c) => `${c.name} (${c.studentCode}, born ${c.dateOfBirth}): ${c.reason.toLowerCase()}`).join('; ');
        o.messages.push({ severity: 'warning', code: 'POSSIBLE_DUPLICATE', message: `This child may already be in the system: ${list}. Choose "link to existing", "create new" or "skip".` });
      }
      s.guardians.forEach((g, i) => {
        const hit = guardians.get(g.phonePrimary);
        if (!hit) return;
        g.existingGuardianId = hit.id;
        const differs = nameSimilarity(hit.name, `${g.firstName} ${g.lastName}`) < 0.4;
        o.messages.push({
          severity: differs ? 'warning' : 'info',
          code: 'GUARDIAN_EXISTS',
          field: `g${i + 1}Phone`,
          message: differs
            ? `Guardian ${i + 1}'s phone belongs to ${hit.name}, who is already in the system. The child will be linked to ${hit.name}. If this is a different person, correct the phone number.`
            : `Guardian ${i + 1} (${hit.name}) is already in the system; the child will be linked to them (brothers and sisters are linked this way).`,
        });
      });
    }
  } else if (type === 'staff') {
    const staff = outcomes.filter((o) => o.normalised).map((o) => ({ o, s: o.normalised as NormalisedStaff }));
    const found = await findStaff(db, staff.map(({ s }) => s.staffCode).filter((c): c is string => !!c), staff.map(({ s }) => s.phone));
    for (const { o, s } of staff) {
      if (s.staffCode && found.byCode.has(s.staffCode)) {
        o.messages.push({ severity: 'error', code: 'STAFF_CODE_EXISTS', field: 'staffCode', message: `Staff ID ${s.staffCode} already exists in the system.` });
      }
      const p = found.byPhone.get(s.phone);
      if (p) {
        dupes.set(o.rowNumber, [{ staffId: p.id, name: p.name, code: p.code, reason: 'Same phone number' }]);
        o.messages.push({ severity: 'warning', code: 'POSSIBLE_DUPLICATE', field: 'phone', message: `${p.name} (${p.code}) already has this phone number. Choose "link to existing", "create new" or "skip".` });
      }
    }
  } else {
    const bal = outcomes.filter((o) => o.normalised).map((o) => ({ o, b: o.normalised as NormalisedBalance }));
    const found = await findBalanceStudents(db, bal.map(({ b }) => b.studentCode).filter((c): c is string => !!c), bal.map(({ b }) => b.legacyId).filter((c): c is string => !!c));
    for (const { o, b } of bal) {
      const st = (b.studentCode && found.byCode.get(b.studentCode)) || (b.legacyId && found.byLegacy.get(b.legacyId)) || null;
      if (!st) {
        o.messages.push({
          severity: 'error',
          code: 'STUDENT_NOT_FOUND',
          field: b.studentCode ? 'studentCode' : 'legacyId',
          message: b.studentCode ? `No student has the ID ${b.studentCode}.` : `No imported student has the Old Student ID ${b.legacyId}. Import the students first, or use the new Student ID.`,
        });
        continue;
      }
      b.studentId = st.id;
      if (b.studentName && nameSimilarity(b.studentName, st.name) < 0.3) {
        o.messages.push({ severity: 'warning', code: 'NAME_MISMATCH', field: 'studentName', message: `The name "${b.studentName}" does not match the student ${st.name} (${st.code}). Check you have the right child.` });
      }
      o.messages.push({ severity: 'info', code: 'WILL_POST', message: `${formatCedis(Math.abs(b.amountPesewas))} ${b.amountPesewas >= 0 ? 'owed by' : 'credit for'} ${st.name} (${st.code}).` });
    }
    const already = await studentsWithOpeningBalance(db, bal.map(({ b }) => b.studentId).filter((x): x is string => !!x));
    for (const { o, b } of bal) {
      if (b.studentId && already.has(b.studentId)) {
        o.messages.push({ severity: 'error', code: 'OPENING_BALANCE_EXISTS', message: 'This student already has an opening balance. To change it, ask the bursar to record an adjustment instead.' });
      }
    }
  }

  return outcomes.map((o) => {
    const status = statusFor(o.messages, dupes.has(o.rowNumber));
    const normalised: StoredNormalised | null = o.normalised && status !== 'error' ? { ...o.normalised, ...(dupes.has(o.rowNumber) ? { duplicates: dupes.get(o.rowNumber) } : {}) } : null;
    return { rowNumber: o.rowNumber, status, messages: o.messages, normalised };
  });
}
