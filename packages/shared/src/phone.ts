/** Ghana phone normalisation to E.164 (+233XXXXXXXXX). Returns null when not a valid Ghana mobile/landline. */
export function normaliseGhanaPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  let national: string;
  if (/^\+233\d{9}$/.test(digits)) national = digits.slice(4);
  else if (/^00233\d{9}$/.test(digits)) national = digits.slice(5);
  else if (/^233\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{9}$/.test(digits)) national = digits;
  else return null;
  if (!/^[235]\d{8}$/.test(national)) return null;
  return `+233${national}`;
}

/** Mask for logs: +233241234567 -> +233*****4567 */
export function maskPhone(e164: string): string {
  return e164.length > 8 ? `${e164.slice(0, 4)}*****${e164.slice(-4)}` : '****';
}
