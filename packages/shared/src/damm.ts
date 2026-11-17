/**
 * Damm check digit (detects all single-digit errors and all adjacent transpositions).
 * Used for the permanent student code: SCHOOL-YY-NNNNN-C where C = damm(YY + NNNNN).
 */
const TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

export function dammCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new RangeError('digits only');
  let interim = 0;
  for (const ch of digits) interim = TABLE[interim]![Number(ch)]!;
  return interim;
}

export function dammValidate(digitsWithCheck: string): boolean {
  if (!/^\d+$/.test(digitsWithCheck)) return false;
  return dammCheckDigit(digitsWithCheck) === 0;
}

export const STUDENT_CODE_PATTERN = /^([A-Z]{3})-(\d{2})-(\d{5})-(\d)$/;

export function formatStudentCode(schoolCode: string, admissionYear: number, seq: number): string {
  if (!/^[A-Z]{3}$/.test(schoolCode)) throw new RangeError('school code must be 3 capital letters');
  if (seq < 1 || seq > 99999) throw new RangeError('sequence out of range');
  const yy = String(admissionYear % 100).padStart(2, '0');
  const nnnnn = String(seq).padStart(5, '0');
  return `${schoolCode}-${yy}-${nnnnn}-${dammCheckDigit(yy + nnnnn)}`;
}

export function isValidStudentCode(code: string): boolean {
  const m = STUDENT_CODE_PATTERN.exec(code);
  if (!m) return false;
  return dammValidate(m[2]! + m[3]! + m[4]!);
}
