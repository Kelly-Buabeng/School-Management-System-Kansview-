// Owner: Agent B. Pure admission rules shared by manual admission and the import target.
import { AppError } from '../../common/app-error';
import { ErrorCodes } from '@sms/shared';

export interface GuardianLinkFlags {
  isPrimary?: boolean;
  isFeePayer?: boolean;
  canPickUp?: boolean;
  receivesSms?: boolean;
  livesWithStudent?: boolean;
}

/**
 * At most one primary guardian. When nobody is marked primary the first guardian becomes primary,
 * and when nobody is marked fee payer the primary pays (so invoices always have a payer).
 */
export function normaliseGuardianFlags<T extends object>(input: T[]): Array<Omit<T, keyof GuardianLinkFlags> & Required<GuardianLinkFlags>> {
  const links = input as Array<T & GuardianLinkFlags>;
  const primaries = links.filter((l) => l.isPrimary).length;
  if (primaries > 1) {
    throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Only one guardian can be the main contact', undefined, [
      { field: 'guardians', code: 'MULTIPLE_PRIMARY', message: 'Mark only one guardian as the main contact' },
    ]);
  }
  const anyPayer = links.some((l) => l.isFeePayer);
  return links.map((l, i) => {
    const isPrimary = primaries === 0 ? i === 0 : !!l.isPrimary;
    return {
      ...l,
      isPrimary,
      isFeePayer: anyPayer ? !!l.isFeePayer : isPrimary,
      canPickUp: l.canPickUp ?? true,
      receivesSms: l.receivesSms ?? true,
      livesWithStudent: l.livesWithStudent ?? false,
    };
  });
}

export interface ContactInput {
  priority?: number;
  guardianId?: string;
  name?: string;
  relationship?: string;
  phone?: string;
  notes?: string;
}

/**
 * Orders emergency contacts and renumbers priorities 1..n (gaps allowed in the input, duplicates not).
 * Each contact is a linked guardian, or a name + phone.
 */
export function normaliseContacts<T extends ContactInput>(contacts: T[]): Array<T & { priority: number }> {
  const seen = new Set<number>();
  contacts.forEach((c, i) => {
    if (c.priority !== undefined) {
      if (seen.has(c.priority)) {
        throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Two contacts have the same order number', undefined, [
          { field: `emergencyContacts.${i}.priority`, code: 'DUPLICATE', message: 'Each contact needs a different order number' },
        ]);
      }
      seen.add(c.priority);
    }
    if (!c.guardianId && !(c.name && c.phone)) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Each emergency contact needs a guardian, or a name and phone number', undefined, [
        { field: `emergencyContacts.${i}`, code: 'INCOMPLETE', message: 'Choose a guardian or type a name and phone number' },
      ]);
    }
  });
  return contacts
    .map((c, i) => ({ c, key: c.priority ?? Number.MAX_SAFE_INTEGER, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map(({ c }, idx) => ({ ...c, priority: idx + 1 }));
}

/** Two-digit admission year for codes: Ghana's academic year starts in September; the code uses the admission date's year. */
export function admissionYearOf(admissionDate: string): number {
  return Number(admissionDate.slice(0, 4));
}

export interface DuplicateCandidate {
  studentId: string;
  studentCode: string;
  fullName: string;
  dateOfBirth: string;
  similarity: number;
  sharedPhones: string[];
  className: string | null;
  status: string;
}

/** The duplicate rule: similar name AND same date of birth AND at least one shared guardian phone. */
export function isPossibleDuplicate(c: { similarity: number; sameDob: boolean; sharedPhones: string[] }, threshold = 0.6): boolean {
  return c.similarity >= threshold && c.sameDob && c.sharedPhones.length > 0;
}

/** Next roll number in a class: max + 1 (1 for an empty class). */
export function nextRollNumber(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

/** Alphabetical roll order: last name, first name, then student code for stability. */
export function alphabeticalRoll<T extends { lastName: string; firstName: string; studentCode: string }>(rows: T[]): Array<T & { rollNumber: number }> {
  return [...rows]
    .sort((a, b) => a.lastName.localeCompare(b.lastName, 'en', { sensitivity: 'base' }) || a.firstName.localeCompare(b.firstName, 'en', { sensitivity: 'base' }) || a.studentCode.localeCompare(b.studentCode))
    .map((r, i) => ({ ...r, rollNumber: i + 1 }));
}
