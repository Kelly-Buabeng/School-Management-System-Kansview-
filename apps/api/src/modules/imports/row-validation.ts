/**
 * Pure row normalisation + validation for each import type. Database look-ups (classes, terms, existing students,
 * guardians, staff) are passed in through ValidationContext / applied afterwards by ImportsValidator, so this file
 * has no I/O and is unit-tested directly.
 */
import { ageOn, isIsoDate, isValidStudentCode, type Pesewas } from '@sms/shared';
import { TEMPLATE_SPECS, type ImportType } from './import-columns';
import type { RawCell, RawRow } from './file-reader';
import {
  cleanText, columnLooksMonthFirst, normaliseName, parseAmount, parseClassLabel, parseDate, parseEmail, parseGender,
  parsePhone, parseRelationship, parseTermLabel, parseYesNo, sameLevelCode, splitFullName, type Result,
} from './normalise';

export type Severity = 'error' | 'warning';
export interface RowMessage {
  severity: Severity;
  code: string;
  message: string;
  field?: string;
}

export type RowStatus = 'valid' | 'warning' | 'error' | 'duplicate';

export interface ClassInfo {
  id: string;
  levelCode: string;
  stream: string | null;
  displayName: string;
  capacity: number | null;
  activeCount: number;
}

export interface TermInfo {
  id: string;
  yearName: string;
  number: number;
}

export interface ValidationContext {
  /** YYYY-MM-DD, Africa/Accra. */
  today: string;
  /** Start date of the current academic year (default admission date, age reference). */
  academicYearStart: string;
  classes: ClassInfo[];
  terms: TermInfo[];
}

export interface NormalisedGuardian {
  firstName: string;
  lastName: string;
  relationship: string;
  phonePrimary: string;
  phoneSecondary: string | null;
  whatsappNumber: string | null;
  email: string | null;
  occupation: string | null;
  isPrimary: boolean;
  isFeePayer: boolean;
  canPickUp: boolean;
  /** Filled by DB matching: an existing guardian with this phone (link instead of create). */
  existingGuardianId?: string | null;
}

export interface NormalisedStudent {
  kind: 'students_guardians';
  legacyId: string | null;
  firstName: string;
  middleNames: string | null;
  lastName: string;
  preferredName: string | null;
  dateOfBirth: string;
  gender: 'male' | 'female';
  classLabel: string;
  classId: string | null;
  admissionDate: string;
  nationality: string | null;
  religion: string | null;
  homeAddress: string | null;
  previousSchool: string | null;
  medical: { alertSummary: string | null; allergies: string | null; bloodGroup: string | null } | null;
  guardians: NormalisedGuardian[];
}

export interface NormalisedStaff {
  kind: 'staff';
  staffCode: string | null;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female';
  dateOfBirth: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  staffType: 'teaching' | 'non_teaching';
  jobTitle: string | null;
  employmentDate: string | null;
  emergencyContact: { name: string; relationship: string | null; phone: string } | null;
}

export interface NormalisedBalance {
  kind: 'opening_balances';
  studentCode: string | null;
  legacyId: string | null;
  studentName: string | null;
  amountPesewas: Pesewas;
  termLabel: string;
  termId: string | null;
  note: string | null;
  /** Filled by DB matching. */
  studentId?: string | null;
}

export type NormalisedRow = NormalisedStudent | NormalisedStaff | NormalisedBalance;

export interface RowOutcome {
  rowNumber: number;
  /** null when the row has errors that stop a usable value being built. */
  normalised: NormalisedRow | null;
  messages: RowMessage[];
}

/** Final status from messages + unresolved duplicate flag. */
export function statusFor(messages: RowMessage[], duplicate: boolean): RowStatus {
  if (messages.some((m) => m.severity === 'error')) return 'error';
  if (duplicate) return 'duplicate';
  if (messages.some((m) => m.severity === 'warning')) return 'warning';
  return 'valid';
}

class Collector {
  readonly messages: RowMessage[] = [];
  error(code: string, message: string, field?: string): void {
    this.messages.push({ severity: 'error', code, message, ...(field ? { field } : {}) });
  }
  warn(code: string, message: string, field?: string): void {
    this.messages.push({ severity: 'warning', code, message, ...(field ? { field } : {}) });
  }
  take<T>(r: Result<T>, field: string, code = 'INVALID'): T | undefined {
    if (!r.ok) {
      this.error(code, r.error, field);
      return undefined;
    }
    if (r.warning) this.warn(code === 'INVALID' ? 'CHECK' : code, r.warning, field);
    return r.value;
  }
  get hasErrors(): boolean {
    return this.messages.some((m) => m.severity === 'error');
  }
}

/** Typical age (on the first day of the academic year) for each seeded level code. */
const TYPICAL_AGE: Record<string, number> = { CRECHE: 1, NURSERY: 3, KG1: 4, KG2: 5, P1: 6, P2: 7, P3: 8, P4: 9, P5: 10, P6: 11, JHS1: 12, JHS2: 13, JHS3: 14 };

export function findClass(label: string, classes: ClassInfo[]): { cls?: ClassInfo; error?: string } {
  const parsed = parseClassLabel(label);
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const byName = classes.filter((c) => norm(c.displayName) === norm(label));
  if (byName.length === 1) return { cls: byName[0]! };
  if (!parsed) return { error: `Class "${label}" is not understood. Use the level and stream, e.g. P3 A or JHS1 B.` };
  const sameLevel = classes.filter((c) => sameLevelCode(c.levelCode, parsed.levelCode));
  if (sameLevel.length === 0) return { error: `There is no ${parsed.levelCode} class this academic year. Create it under Classes first, or correct the class.` };
  if (parsed.stream) {
    const hit = sameLevel.find((c) => (c.stream ?? '').toUpperCase() === parsed.stream);
    if (hit) return { cls: hit };
    if (sameLevel.length === 1 && !sameLevel[0]!.stream) return { cls: sameLevel[0]! };
    return { error: `Class "${label}" was not found. ${parsed.levelCode} classes this year: ${sameLevel.map((c) => c.displayName).join(', ')}.` };
  }
  if (sameLevel.length === 1) return { cls: sameLevel[0]! };
  return { error: `Class "${label}": which stream? ${parsed.levelCode} has ${sameLevel.map((c) => c.displayName).join(', ')}.` };
}

/** Reads cells by column key using the header mapping. */
export function keyedCells(row: RawRow, mapping: Record<string, string>): Record<string, RawCell> {
  const out: Record<string, RawCell> = {};
  for (const [header, value] of Object.entries(row.cells)) {
    const key = mapping[header];
    if (key) out[key] = value;
  }
  return out;
}

function headerOf(type: ImportType, key: string): string {
  return TEMPLATE_SPECS[type].columns.find((c) => c.key === key)?.header ?? key;
}

/** Per-column facts needed by row validation (e.g. whether a date column is written month-first). */
export interface ColumnFacts {
  monthFirst: Set<string>;
}

export function columnFacts(type: ImportType, rows: Array<Record<string, RawCell>>, currentYear: number): ColumnFacts {
  const monthFirst = new Set<string>();
  for (const c of TEMPLATE_SPECS[type].columns) {
    if (c.kind === 'date' && columnLooksMonthFirst(rows.map((r) => r[c.key]), currentYear)) monthFirst.add(c.key);
  }
  return { monthFirst };
}

// ------------------------------------------------------------------ students + guardians

function guardianFrom(cells: Record<string, RawCell>, n: 1 | 2, col: Collector): NormalisedGuardian | null {
  const p = `g${n}`;
  const label = (f: string) => `${headerOf('students_guardians', `${p}${f}`)}`;
  const keys = ['FullName', 'FirstName', 'LastName', 'Relationship', 'Phone', 'OtherPhone', 'Whatsapp', 'Email', 'Occupation'];
  const anyGiven = keys.some((k) => cleanText(cells[`${p}${k}`]) !== null);
  if (!anyGiven) {
    if (n === 1) col.error('REQUIRED', 'Guardian 1 is missing. Every student needs at least one parent or guardian with a phone number.', 'g1FirstName');
    return null;
  }
  let firstName = normaliseName(cells[`${p}FirstName`]);
  let lastName = normaliseName(cells[`${p}LastName`]);
  if (!firstName && !lastName) {
    const split = splitFullName(cells[`${p}FullName`]);
    if (split) {
      firstName = [split.firstName, split.middleNames].filter(Boolean).join(' ');
      lastName = split.lastName;
    } else firstName = normaliseName(cells[`${p}FullName`]);
  }
  if (firstName && !lastName && firstName.includes(' ')) {
    const parts = firstName.split(' ');
    lastName = parts.pop()!;
    firstName = parts.join(' ');
  }
  if (!firstName) col.error('REQUIRED', `${label('FirstName')} is required.`, `${p}FirstName`);
  if (!lastName) col.error('REQUIRED', `${label('LastName')} is required.`, `${p}LastName`);
  let relationship = col.take(parseRelationship(cells[`${p}Relationship`]), `${p}Relationship`);
  if (!relationship) {
    col.warn('DEFAULTED', `${label('Relationship')} is empty, so it was saved as Guardian.`, `${p}Relationship`);
    relationship = 'guardian';
  }
  const phone = col.take(parsePhone(cells[`${p}Phone`], label('Phone')), `${p}Phone`, 'INVALID_PHONE');
  const other = col.take(parsePhone(cells[`${p}OtherPhone`], label('OtherPhone')), `${p}OtherPhone`, 'INVALID_PHONE');
  const wa = col.take(parsePhone(cells[`${p}Whatsapp`], label('Whatsapp')), `${p}Whatsapp`, 'INVALID_PHONE');
  if (phone && !phone.primary) col.error('REQUIRED', `${label('Phone')} is required.`, `${p}Phone`);
  const email = col.take(parseEmail(cells[`${p}Email`], label('Email')), `${p}Email`);
  const fee = col.take(parseYesNo(cells[`${p}FeePayer`]), `${p}FeePayer`);
  const pick = col.take(parseYesNo(cells[`${p}CanPickUp`]), `${p}CanPickUp`);
  if (!firstName || !lastName || !phone?.primary) return null;
  return {
    firstName,
    lastName,
    relationship,
    phonePrimary: phone.primary,
    phoneSecondary: other?.primary ?? phone.extra ?? null,
    whatsappNumber: wa?.primary ?? null,
    email: email ?? null,
    occupation: cleanText(cells[`${p}Occupation`]),
    isPrimary: n === 1,
    isFeePayer: fee ?? false,
    canPickUp: pick ?? true,
  };
}

export function validateStudentRow(cells: Record<string, RawCell>, ctx: ValidationContext, facts: ColumnFacts): { normalised: NormalisedStudent | null; messages: RowMessage[] } {
  const col = new Collector();
  const currentYear = Number(ctx.today.slice(0, 4));
  let firstName = normaliseName(cells.firstName);
  let lastName = normaliseName(cells.lastName);
  let middleNames = normaliseName(cells.middleNames);
  if ((!firstName || !lastName) && cleanText(cells.fullName)) {
    const split = splitFullName(cells.fullName);
    if (split) {
      firstName ??= split.firstName;
      lastName ??= split.lastName;
      middleNames ??= split.middleNames;
      if (split.guessed) col.warn('NAME_SPLIT', `The name "${cleanText(cells.fullName)}" was split as first name "${split.firstName}" and surname "${split.lastName}". Please check.`, 'fullName');
    }
  }
  if (!firstName) col.error('REQUIRED', 'First Name is required.', 'firstName');
  if (!lastName) col.error('REQUIRED', 'Last Name is required.', 'lastName');

  const dob = col.take(parseDate(cells.dateOfBirth, 'Date of Birth', { currentYear, columnLooksMonthFirst: facts.monthFirst.has('dateOfBirth') }), 'dateOfBirth', 'INVALID_DATE');
  if (dob === null) col.error('REQUIRED', 'Date of Birth is required.', 'dateOfBirth');
  if (dob && dob > ctx.today) col.error('INVALID_DATE', 'Date of Birth is in the future.', 'dateOfBirth');

  const gender = col.take(parseGender(cells.gender), 'gender');
  if (gender === null) col.error('REQUIRED', 'Gender is required (Male or Female).', 'gender');

  const classLabel = cleanText(cells.class);
  let classId: string | null = null;
  let levelCode: string | null = null;
  if (!classLabel) col.error('REQUIRED', 'Class is required, e.g. P3 A.', 'class');
  else {
    const found = findClass(classLabel, ctx.classes);
    if (found.error) col.error('CLASS_NOT_FOUND', found.error, 'class');
    else if (found.cls) {
      classId = found.cls.id;
      levelCode = found.cls.levelCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
  }

  if (dob && levelCode && TYPICAL_AGE[levelCode] !== undefined && dob <= ctx.today) {
    const age = ageOn(dob, ctx.academicYearStart);
    const typical = TYPICAL_AGE[levelCode]!;
    if (age < typical - 2 || age > typical + 3) {
      col.warn('AGE_UNUSUAL', `Age ${age} is unusual for ${classLabel} (most children are about ${typical}). Check the date of birth and class.`, 'dateOfBirth');
    }
  }
  if (dob && ageOn(dob, ctx.today) > 25) col.error('INVALID_DATE', 'Date of Birth makes the student older than 25. Check the year.', 'dateOfBirth');

  const admission = col.take(parseDate(cells.admissionDate, 'Admission Date', { currentYear, columnLooksMonthFirst: facts.monthFirst.has('admissionDate') }), 'admissionDate', 'INVALID_DATE');
  if (admission && admission > ctx.today) col.error('INVALID_DATE', 'Admission Date is in the future.', 'admissionDate');
  if (admission && dob && admission < dob) col.error('INVALID_DATE', 'Admission Date is before the Date of Birth.', 'admissionDate');

  const g1 = guardianFrom(cells, 1, col);
  const g2 = guardianFrom(cells, 2, col);
  const guardians = [g1, g2].filter((g): g is NormalisedGuardian => g !== null);
  if (g1 && g2 && g1.phonePrimary === g2.phonePrimary) {
    col.error('DUPLICATE_PHONE', 'Guardian 1 and Guardian 2 have the same phone number. Each guardian needs their own number, or leave Guardian 2 empty.', 'g2Phone');
  }
  if (guardians.length && !guardians.some((g) => g.isFeePayer)) guardians[0]!.isFeePayer = true;

  const alert = cleanText(cells.medicalAlert);
  const allergies = cleanText(cells.allergies);
  const bloodGroup = cleanText(cells.bloodGroup)?.toUpperCase().replace(/\s/g, '') ?? null;
  if (alert && alert.length > 200) col.warn('LONG_TEXT', 'Medical Alert is long. Keep it short (it is shown on the Emergency View); put full details on the medical record later.', 'medicalAlert');
  if (bloodGroup && !/^(A|B|AB|O)[+-]$/.test(bloodGroup)) col.warn('CHECK', `Blood Group "${bloodGroup}" is not a standard group (e.g. O+, AB-).`, 'bloodGroup');

  if (col.hasErrors || !firstName || !lastName || !dob || !gender || !classLabel) return { normalised: null, messages: col.messages };
  return {
    normalised: {
      kind: 'students_guardians',
      legacyId: cleanText(cells.legacyId),
      firstName,
      middleNames,
      lastName,
      preferredName: normaliseName(cells.preferredName),
      dateOfBirth: dob,
      gender,
      classLabel,
      classId,
      admissionDate: admission ?? ctx.academicYearStart,
      nationality: cleanText(cells.nationality) ?? 'Ghanaian',
      religion: cleanText(cells.religion),
      homeAddress: cleanText(cells.homeAddress),
      previousSchool: cleanText(cells.previousSchool),
      medical: alert || allergies || bloodGroup ? { alertSummary: alert ? alert.slice(0, 200) : null, allergies, bloodGroup } : null,
      guardians,
    },
    messages: col.messages,
  };
}

// ------------------------------------------------------------------ staff

export function validateStaffRow(cells: Record<string, RawCell>, ctx: ValidationContext, facts: ColumnFacts): { normalised: NormalisedStaff | null; messages: RowMessage[] } {
  const col = new Collector();
  const currentYear = Number(ctx.today.slice(0, 4));
  const firstName = normaliseName(cells.firstName);
  const lastName = normaliseName(cells.lastName);
  if (!firstName) col.error('REQUIRED', 'First Name is required.', 'firstName');
  if (!lastName) col.error('REQUIRED', 'Last Name is required.', 'lastName');
  const gender = col.take(parseGender(cells.gender), 'gender');
  if (gender === null) col.error('REQUIRED', 'Gender is required (Male or Female).', 'gender');
  const dob = col.take(parseDate(cells.dateOfBirth, 'Date of Birth', { currentYear, columnLooksMonthFirst: facts.monthFirst.has('dateOfBirth') }), 'dateOfBirth', 'INVALID_DATE');
  if (dob) {
    const age = ageOn(dob, ctx.today);
    if (age < 16 || age > 80) col.warn('AGE_UNUSUAL', `Age ${age} is unusual for a member of staff. Check the year.`, 'dateOfBirth');
  }
  const phone = col.take(parsePhone(cells.phone, 'Phone'), 'phone', 'INVALID_PHONE');
  if (phone && !phone.primary) col.error('REQUIRED', 'Phone is required.', 'phone');
  const email = col.take(parseEmail(cells.email, 'Email'), 'email');
  const typeRaw = cleanText(cells.staffType)?.toLowerCase().replace(/[^a-z]/g, '');
  let staffType: 'teaching' | 'non_teaching' | null = null;
  if (!typeRaw) col.error('REQUIRED', 'Staff Type is required (Teaching or Non-teaching).', 'staffType');
  else if (['teaching', 'teacher', 't', 'academic'].includes(typeRaw)) staffType = 'teaching';
  else if (['nonteaching', 'nonteacher', 'nt', 'support', 'nonacademic', 'administrative', 'admin'].includes(typeRaw)) staffType = 'non_teaching';
  else col.error('INVALID', `Staff Type "${cleanText(cells.staffType)}" should be Teaching or Non-teaching.`, 'staffType');
  const employment = col.take(parseDate(cells.employmentDate, 'Employment Date', { currentYear, columnLooksMonthFirst: facts.monthFirst.has('employmentDate') }), 'employmentDate', 'INVALID_DATE');
  if (employment && employment > ctx.today) col.warn('CHECK', 'Employment Date is in the future.', 'employmentDate');
  const eName = normaliseName(cells.emergencyName);
  const ePhone = col.take(parsePhone(cells.emergencyPhone, 'Emergency Contact Phone'), 'emergencyPhone', 'INVALID_PHONE');
  if (eName && !ePhone?.primary) col.warn('CHECK', 'Emergency contact has no valid phone number, so it was left out.', 'emergencyPhone');
  if (col.hasErrors || !firstName || !lastName || !gender || !phone?.primary || !staffType) return { normalised: null, messages: col.messages };
  return {
    normalised: {
      kind: 'staff',
      staffCode: cleanText(cells.staffCode)?.toUpperCase() ?? null,
      firstName,
      lastName,
      gender,
      dateOfBirth: dob ?? null,
      phone: phone.primary,
      email: email ?? null,
      address: cleanText(cells.address),
      staffType,
      jobTitle: cleanText(cells.jobTitle),
      employmentDate: employment ?? null,
      emergencyContact: eName && ePhone?.primary ? { name: eName, relationship: cleanText(cells.emergencyRelationship), phone: ePhone.primary } : null,
    },
    messages: col.messages,
  };
}

// ------------------------------------------------------------------ opening balances

export function validateBalanceRow(cells: Record<string, RawCell>, ctx: ValidationContext): { normalised: NormalisedBalance | null; messages: RowMessage[] } {
  const col = new Collector();
  const studentCode = cleanText(cells.studentCode)?.toUpperCase().replace(/\s/g, '') ?? null;
  const legacyId = cleanText(cells.legacyId);
  if (!studentCode && !legacyId) col.error('REQUIRED', 'Fill in the Student ID or the Old Student ID.', 'studentCode');
  if (studentCode && !/^[A-Z]{3}-\d{2}-\d{5}-\d$/.test(studentCode)) col.error('INVALID', `Student ID "${studentCode}" is not in the right format (e.g. KSV-26-00417-7).`, 'studentCode');
  else if (studentCode && !isValidStudentCode(studentCode)) col.error('INVALID', `Student ID "${studentCode}" has a typing mistake (the last digit does not match). Check it against the student record.`, 'studentCode');
  const amount = col.take(parseAmount(cells.amount, 'Amount'), 'amount', 'INVALID_AMOUNT');
  if (amount === null) col.error('REQUIRED', 'Amount is required.', 'amount');
  if (amount === 0) col.warn('ZERO_AMOUNT', 'Amount is zero, so nothing will be posted for this student.', 'amount');
  if (amount !== undefined && amount !== null && Math.abs(amount) > 10_000_000) col.warn('CHECK', 'Amount is over GH₵ 100,000. Please check it.', 'amount');
  const termRaw = cleanText(cells.asOfTerm);
  let termId: string | null = null;
  if (!termRaw) col.error('REQUIRED', 'As of Term is required, e.g. 2026/2027 Term 1.', 'asOfTerm');
  else {
    const t = parseTermLabel(termRaw);
    const hit = t && ctx.terms.find((x) => x.yearName === t.yearName && x.number === t.number);
    if (!t) col.error('INVALID', `Term "${termRaw}" is not understood. Write it like 2026/2027 Term 1.`, 'asOfTerm');
    else if (!hit) col.error('TERM_NOT_FOUND', `Term ${t.number} of ${t.yearName} does not exist in the system. Set up the academic year first.`, 'asOfTerm');
    else termId = hit.id;
  }
  if (col.hasErrors || amount === null || amount === undefined || !termRaw) return { normalised: null, messages: col.messages };
  return {
    normalised: { kind: 'opening_balances', studentCode, legacyId, studentName: cleanText(cells.studentName), amountPesewas: amount, termLabel: termRaw, termId, note: cleanText(cells.note) },
    messages: col.messages,
  };
}

// ------------------------------------------------------------------ file-level checks

export function studentDuplicateKey(s: { firstName: string; lastName: string; dateOfBirth: string }): string {
  return `${s.firstName}|${s.lastName}|${s.dateOfBirth}`.toLowerCase().replace(/[^a-z0-9|-]/g, '');
}

/**
 * Checks across rows of the same file:
 * - the same child twice (first + last name + date of birth) → error on the later rows,
 * - guardians de-duplicated by phone: same phone with a different name → warning (they will be linked as one person),
 * - class capacity (rows in the file + students already in the class) → warning,
 * - staff: repeated staff ID → error; repeated phone → warning,
 * - balances: the same student twice → error.
 */
export function crossRowChecks(type: ImportType, outcomes: RowOutcome[], ctx: ValidationContext): void {
  if (type === 'students_guardians') {
    const seen = new Map<string, number>();
    const guardianByPhone = new Map<string, { name: string; row: number }>();
    const perClass = new Map<string, number>();
    for (const o of outcomes) {
      const s = o.normalised as NormalisedStudent | null;
      if (!s) continue;
      const k = studentDuplicateKey(s);
      const first = seen.get(k);
      if (first !== undefined) o.messages.push({ severity: 'error', code: 'DUPLICATE_IN_FILE', message: `This child appears twice in the file (same name and date of birth as row ${first}). Remove one of the rows.` });
      else seen.set(k, o.rowNumber);
      for (const [i, g] of s.guardians.entries()) {
        const name = `${g.firstName} ${g.lastName}`;
        const prev = guardianByPhone.get(g.phonePrimary);
        if (!prev) guardianByPhone.set(g.phonePrimary, { name, row: o.rowNumber });
        else if (prev.name.toLowerCase() !== name.toLowerCase()) {
          o.messages.push({ severity: 'warning', code: 'GUARDIAN_PHONE_SHARED', field: `g${i + 1}Phone`, message: `Guardian ${i + 1} (${name}) has the same phone as ${prev.name} on row ${prev.row}. They will be saved as ONE guardian (${prev.name}) linked to both children. If they are different people, give each their own number.` });
        }
      }
      if (s.classId) perClass.set(s.classId, (perClass.get(s.classId) ?? 0) + 1);
    }
    for (const o of outcomes) {
      const s = o.normalised as NormalisedStudent | null;
      if (!s?.classId) continue;
      const cls = ctx.classes.find((c) => c.id === s.classId);
      if (cls?.capacity && cls.activeCount + (perClass.get(cls.id) ?? 0) > cls.capacity) {
        o.messages.push({ severity: 'warning', code: 'CLASS_OVER_CAPACITY', field: 'class', message: `${cls.displayName} will have ${cls.activeCount + perClass.get(cls.id)!} students, more than its capacity of ${cls.capacity}. The students will still be imported; raise the capacity under Classes if this is correct.` });
      }
    }
  } else if (type === 'staff') {
    const codes = new Map<string, number>();
    const phones = new Map<string, number>();
    for (const o of outcomes) {
      const s = o.normalised as NormalisedStaff | null;
      if (!s) continue;
      if (s.staffCode) {
        const p = codes.get(s.staffCode);
        if (p !== undefined) o.messages.push({ severity: 'error', code: 'DUPLICATE_IN_FILE', field: 'staffCode', message: `Staff ID ${s.staffCode} is also used on row ${p}.` });
        else codes.set(s.staffCode, o.rowNumber);
      }
      const p = phones.get(s.phone);
      if (p !== undefined) o.messages.push({ severity: 'warning', code: 'DUPLICATE_PHONE', field: 'phone', message: `The same phone number is used on row ${p}. Is this the same person twice?` });
      else phones.set(s.phone, o.rowNumber);
    }
  } else {
    const keys = new Map<string, number>();
    for (const o of outcomes) {
      const b = o.normalised as NormalisedBalance | null;
      if (!b) continue;
      const k = (b.studentCode ?? `legacy:${b.legacyId}`).toLowerCase();
      const p = keys.get(k);
      if (p !== undefined) o.messages.push({ severity: 'error', code: 'DUPLICATE_IN_FILE', field: 'studentCode', message: `This student already has a balance on row ${p}. Put one total per student.` });
      else keys.set(k, o.rowNumber);
    }
  }
}

/** Validates every parsed row of a file (pure part). */
export function validateRows(type: ImportType, rows: RawRow[], mapping: Record<string, string>, ctx: ValidationContext): RowOutcome[] {
  if (!isIsoDate(ctx.today)) throw new RangeError('ctx.today must be YYYY-MM-DD');
  const keyed = rows.map((r) => keyedCells(r, mapping));
  const facts = columnFacts(type, keyed, Number(ctx.today.slice(0, 4)));
  const outcomes: RowOutcome[] = rows.map((r, i) => {
    const cells = keyed[i]!;
    const res = type === 'students_guardians' ? validateStudentRow(cells, ctx, facts) : type === 'staff' ? validateStaffRow(cells, ctx, facts) : validateBalanceRow(cells, ctx);
    return { rowNumber: r.rowNumber, normalised: res.normalised, messages: res.messages };
  });
  crossRowChecks(type, outcomes, ctx);
  return outcomes;
}

/** Required columns that are missing from the file's headings (file-level problem). */
export function missingRequiredColumns(type: ImportType, mapping: Record<string, string>): string[] {
  const present = new Set(Object.values(mapping));
  const spec = TEMPLATE_SPECS[type];
  return spec.columns
    .filter((c) => c.required && !present.has(c.key))
    .filter((c) => !(type === 'students_guardians' && (c.key === 'firstName' || c.key === 'lastName') && present.has('fullName')))
    .filter((c) => !(type === 'students_guardians' && /^g1(First|Last)Name$/.test(c.key) && present.has('g1FullName')))
    .filter((c) => c.key !== 'g1Relationship') // defaults to "Guardian" with a row warning
    .filter((c) => !(type === 'opening_balances' && c.key === 'studentCode'))
    .map((c) => c.header);
}
