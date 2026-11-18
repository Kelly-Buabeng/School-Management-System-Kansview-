import { dammCheckDigit } from '@sms/shared';

/** KSV-26-00417-7: 3 letters, 2-digit year, 5-digit sequence, Damm check digit over year+sequence. */
export function isValidStudentCode(code: string): boolean {
  const m = /^[A-Z]{3}-(\d{2})-(\d{5})-(\d)$/.exec(code);
  return !!m && dammCheckDigit(m[1]! + m[2]!) === Number(m[3]);
}
