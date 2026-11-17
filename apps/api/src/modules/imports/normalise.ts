/**
 * Pure normalisation helpers for imported cells. No I/O, heavily unit-tested (normalise.spec.ts).
 * Each helper returns either a value or a plain-English problem for the row report.
 */
import { normaliseGhanaPhone, parseCedis, type Pesewas } from '@sms/shared';
import type { RawCell } from './file-reader';

export type Result<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

const ok = <T>(value: T, warning?: string): Result<T> => (warning ? { ok: true, value, warning } : { ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

/** Trim, collapse inner whitespace, remove non-breaking/zero-width spaces. Empty → null. */
export function cleanText(v: RawCell | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s === '' || s === '-' || /^n\/?a$/i.test(s) ? null : s;
}

function capitalisePart(p: string): string {
  return p.charAt(0).toLocaleUpperCase('en-GB') + p.slice(1).toLocaleLowerCase('en-GB');
}

/**
 * Name casing: "KWAME" → "Kwame", "ama  owusu-ansah" → "Ama Owusu-Ansah", "o'neil" → "O'Neil".
 * Mixed-case input (e.g. "DeGraft") is kept as typed, because the person probably meant it.
 */
export function normaliseName(v: RawCell | undefined): string | null {
  const s = cleanText(v);
  if (!s) return null;
  const letters = s.replace(/[^\p{L}]/gu, '');
  const allUpper = letters === letters.toLocaleUpperCase('en-GB');
  const allLower = letters === letters.toLocaleLowerCase('en-GB');
  if (!allUpper && !allLower) return s;
  return s
    .split(' ')
    .map((word) => word.split('-').map((part) => part.split("'").map(capitalisePart).join("'")).join('-'))
    .join(' ');
}

// ------------------------------------------------------------------ dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function expandYear(y: number, currentYear: number): number {
  if (y >= 100) return y;
  const yy = currentYear % 100;
  return y <= yy ? 2000 + y : 1900 + y;
}

function longDate(d: number, m: number, y: number): string {
  const name = Object.keys(MONTHS).find((k) => MONTHS[k] === m && k.length > 3) ?? '';
  return `${d} ${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

export interface DateParse {
  value: string;
  /** Both numbers ≤ 12 and different, e.g. 05/03/2015: read as 5 March (Ghana style), but could be 3 May. */
  ambiguous: boolean;
  /** Only valid as month/day (second number > 12): swapped with a warning. */
  swapped: boolean;
}

export interface DateOptions {
  /** For 2-digit years. Defaults to the current year. */
  currentYear?: number;
  /** The column contains month/day dates elsewhere, so ambiguous values here deserve a warning. */
  columnLooksMonthFirst?: boolean;
}

/** Excel stores dates as days since 1899-12-30 (1900 date system, including Excel's leap-year bug offset). */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 80000) return null;
  const ms = Math.round((Math.floor(serial) - 25569) * 86400000);
  const d = new Date(ms);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Parses dates the way Ghanaian schools write them: DD/MM/YYYY, D-M-YY, 12.03.2015, 12 March 2015, 12th Mar, 2015,
 * March 12 2015, 2015-03-12 (ISO) and Excel serial numbers. Day comes before month unless that is impossible.
 */
export function parseDateDetailed(v: RawCell | undefined, opts: DateOptions = {}): DateParse | { error: string } | null {
  if (v === null || v === undefined) return null;
  const currentYear = opts.currentYear ?? new Date().getUTCFullYear();
  if (typeof v === 'number') {
    const s = excelSerialToIso(v);
    return s ? { value: s, ambiguous: false, swapped: false } : { error: `"${v}" is not a date` };
  }
  const raw = cleanText(v);
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t ].*)?$/.exec(s);
  if (m) {
    const out = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return out ? { value: out, ambiguous: false, swapped: false } : { error: `"${raw}" is not a real date` };
  }
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = expandYear(Number(m[3]), currentYear);
    const dayFirst = iso(y, b, a);
    if (dayFirst) return { value: dayFirst, ambiguous: a <= 12 && b <= 12 && a !== b, swapped: false };
    const monthFirst = iso(y, a, b);
    if (monthFirst) return { value: monthFirst, ambiguous: false, swapped: true };
    return { error: `"${raw}" is not a real date` };
  }
  m = /^(\d{1,2})[-/ ]([a-z]+)\.?[-/ ](\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2]!]) {
    const out = iso(expandYear(Number(m[3]), currentYear), MONTHS[m[2]!]!, Number(m[1]));
    return out ? { value: out, ambiguous: false, swapped: false } : { error: `"${raw}" is not a real date` };
  }
  m = /^([a-z]+)\.? (\d{1,2}) (\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[1]!]) {
    const out = iso(expandYear(Number(m[3]), currentYear), MONTHS[m[1]!]!, Number(m[2]));
    return out ? { value: out, ambiguous: false, swapped: false } : { error: `"${raw}" is not a real date` };
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const out = excelSerialToIso(Number(s));
    if (out) return { value: out, ambiguous: false, swapped: false };
  }
  return { error: `"${raw}" is not a date we understand. Use day/month/year, e.g. 12/03/2015` };
}

/** Wrapper returning a row-report friendly Result with ambiguity/swap warnings. */
export function parseDate(v: RawCell | undefined, label: string, opts: DateOptions = {}): Result<string | null> {
  const r = parseDateDetailed(v, opts);
  if (r === null) return ok(null);
  if ('error' in r) return fail(`${label}: ${r.error}`);
  const [y, mo, d] = r.value.split('-').map(Number) as [number, number, number];
  if (r.swapped) return ok(r.value, `${label}: "${cleanText(v)}" only makes sense as month/day, so it was read as ${longDate(d, mo, y)}. Please check.`);
  if (r.ambiguous && opts.columnLooksMonthFirst) {
    return ok(r.value, `${label}: "${cleanText(v)}" was read as ${longDate(d, mo, y)} (day/month). Other dates in this column look like month/day, so please check.`);
  }
  return ok(r.value);
}

/** True when some value in the column is only valid as month/day (e.g. 03/25/2015). */
export function columnLooksMonthFirst(values: Array<RawCell | undefined>, currentYear?: number): boolean {
  return values.some((v) => {
    const r = parseDateDetailed(v, currentYear ? { currentYear } : {});
    return !!r && !('error' in r) && r.swapped;
  });
}

// ------------------------------------------------------------------ other fields

export function parseGender(v: RawCell | undefined): Result<'male' | 'female' | null> {
  const s = cleanText(v)?.toLowerCase().replace(/\./g, '');
  if (!s) return ok(null);
  if (['m', 'male', 'boy', 'b', 'man', 'masculine'].includes(s)) return ok('male');
  if (['f', 'female', 'girl', 'g', 'woman', 'feminine'].includes(s)) return ok('female');
  return fail(`Gender "${cleanText(v)}" is not understood. Use Male or Female.`);
}

export function parseYesNo(v: RawCell | undefined): Result<boolean | null> {
  if (typeof v === 'boolean') return ok(v);
  const s = cleanText(v)?.toLowerCase();
  if (!s) return ok(null);
  if (['yes', 'y', 'true', '1', 'x', '✓', '✔', 'ok'].includes(s)) return ok(true);
  if (['no', 'n', 'false', '0'].includes(s)) return ok(false);
  return fail(`"${cleanText(v)}" should be Yes or No.`);
}

const RELATIONSHIPS: Record<string, string> = {
  mother: 'mother', mum: 'mother', mom: 'mother', mummy: 'mother', mommy: 'mother', ma: 'mother', maa: 'mother', mama: 'mother', stepmother: 'mother',
  father: 'father', dad: 'father', daddy: 'father', papa: 'father', pa: 'father', paa: 'father', stepfather: 'father',
  grandparent: 'grandparent', grandmother: 'grandparent', grandfather: 'grandparent', grandma: 'grandparent', grandpa: 'grandparent', granny: 'grandparent', nana: 'grandparent', grandmom: 'grandparent', granddad: 'grandparent',
  aunt: 'aunt', auntie: 'aunt', aunty: 'aunt',
  uncle: 'uncle',
  sibling: 'sibling', brother: 'sibling', sister: 'sibling', elderbrother: 'sibling', eldersister: 'sibling',
  guardian: 'guardian', legalguardian: 'guardian', caregiver: 'guardian', carer: 'guardian', sponsor: 'guardian',
  other: 'other', cousin: 'other', family: 'other', relative: 'other', friend: 'other',
};

export function parseRelationship(v: RawCell | undefined): Result<string | null> {
  const s = cleanText(v);
  if (!s) return ok(null);
  const k = s.toLowerCase().replace(/[^a-z]/g, '');
  const r = RELATIONSHIPS[k];
  if (r) return ok(r);
  return ok('other', `Relationship "${s}" was saved as Other.`);
}

export interface PhoneParse {
  primary: string | null;
  /** A second number found in the same cell ("0244000101 / 0200000102"). */
  extra: string | null;
}

/** Phones via normaliseGhanaPhone; accepts "024 400 0101", "+233 24 400 0101", numbers that lost the leading 0 in Excel, and two numbers in one cell. */
export function parsePhone(v: RawCell | undefined, label: string): Result<PhoneParse> {
  if (v === null || v === undefined) return ok({ primary: null, extra: null });
  const s = typeof v === 'number' ? String(Math.trunc(v)) : cleanText(v);
  if (!s) return ok({ primary: null, extra: null });
  const parts = s.split(/\s*(?:\/|,|;|\bor\b|&|\|)\s*/i).filter((p) => p.trim() !== '');
  const first = normaliseGhanaPhone(parts[0] ?? '');
  if (!first) return fail(`${label}: "${s}" is not a valid Ghana phone number (expected 10 digits like 024 400 0123).`);
  const second = parts[1] ? normaliseGhanaPhone(parts[1]) : null;
  if (parts.length > 1 && !second) return ok({ primary: first, extra: null }, `${label}: only the first number in "${s}" was used.`);
  return ok({ primary: first, extra: second });
}

export function parseEmail(v: RawCell | undefined, label: string): Result<string | null> {
  const s = cleanText(v)?.toLowerCase();
  if (!s) return ok(null);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return ok(null, `${label}: "${s}" does not look like an email address, so it was left out.`);
  return ok(s);
}

/** Amounts in cedis → integer pesewas via parseCedis. Accepts "GH¢ 1,250", "1250.5", "(150.00)" (negative), numeric cells. */
export function parseAmount(v: RawCell | undefined, label: string): Result<Pesewas | null> {
  if (v === null || v === undefined) return ok(null);
  let s = typeof v === 'number' ? String(v) : cleanText(v);
  if (!s) return ok(null);
  if (/e/i.test(s)) return fail(`${label}: "${s}" is not a valid amount.`);
  s = s.replace(/gh\s*[¢₵c]|ghs|¢|₵|cedis?/gi, '').trim();
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1]!;
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  try {
    const p = parseCedis(s);
    return ok(negative ? -Math.abs(p) : p);
  } catch {
    return fail(`${label}: "${cleanText(String(v))}" is not a valid amount in cedis (e.g. 1,250.00).`);
  }
}

// ------------------------------------------------------------------ classes

export interface ClassLabel {
  levelCode: string;
  stream: string | null;
}

/**
 * "P3 A", "p3a", "Primary 3 A", "Basic 3A", "Class 3 - A", "JHS 1B", "B7" (= JHS1), "KG 2", "Nursery", "Creche".
 * Returns the seeded level code (schema.md) and optional stream letter.
 */
export function parseClassLabel(v: RawCell | undefined): ClassLabel | null {
  const s = cleanText(v)?.toUpperCase().replace(/[()\-_.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const compact = s.replace(/\s/g, '');
  const tryMatch = (re: RegExp, toLevel: (n: number, word?: string) => string | null): ClassLabel | null => {
    const m = re.exec(compact);
    if (!m) return null;
    const level = toLevel(Number(m[2] ?? m[1]), m[1]);
    return level ? { levelCode: level, stream: m[3] ? m[3] : null } : null;
  };
  const basic = (n: number) => (n >= 1 && n <= 6 ? `P${n}` : n >= 7 && n <= 9 ? `JHS${n - 6}` : null);
  return (
    tryMatch(/^(CRECHE|CRÈCHE|DAYCARE)()([A-Z])?$/, () => 'CRECHE') ??
    tryMatch(/^(NURSERY|NUR)(\d)?([A-Z])?$/, () => 'NURSERY') ??
    tryMatch(/^(KG|KINDERGARTEN|K)([12])([A-Z])?$/, (n) => `KG${n}`) ??
    tryMatch(/^(JHS|JSS|FORM)([1-3])([A-Z])?$/, (n) => `JHS${n}`) ??
    tryMatch(/^(P|PRIMARY|PRI|CLASS)([1-6])([A-Z])?$/, (n) => `P${n}`) ??
    tryMatch(/^(B|BASIC|BS)([1-9])([A-Z])?$/, (n) => basic(n))
  );
}

export function sameLevelCode(a: string, b: string): boolean {
  return a.toUpperCase().replace(/[^A-Z0-9]/g, '') === b.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "2026/2027 Term 1", "Term 1 2026/2027", "T1 2026/27", "First Term 2026/2027". */
export function parseTermLabel(v: RawCell | undefined): { yearName: string; number: number } | null {
  const s = cleanText(v)?.toLowerCase();
  if (!s) return null;
  const year = /(\d{4})\s*[/\-]\s*(\d{2,4})/.exec(s);
  if (!year) return null;
  const y1 = Number(year[1]);
  let y2 = Number(year[2]);
  if (y2 < 100) y2 = Math.floor(y1 / 100) * 100 + y2;
  const rest = s.replace(year[0], ' ');
  let n: number | null = null;
  const num = /(?:term|t)\s*([1-3])\b|\b([1-3])\s*(?:st|nd|rd)?\s*term/.exec(rest);
  if (num) n = Number(num[1] ?? num[2]);
  else if (/first/.test(rest)) n = 1;
  else if (/second/.test(rest)) n = 2;
  else if (/third/.test(rest)) n = 3;
  if (!n) return null;
  return { yearName: `${y1}/${y2}`, number: n };
}

/** Splits a single "Name" cell. "MENSAH, Kwame Kofi" → surname first; otherwise first word = first name, last word = surname. */
export function splitFullName(v: RawCell | undefined): { firstName: string; middleNames: string | null; lastName: string; guessed: boolean } | null {
  const s = cleanText(v);
  if (!s) return null;
  const words = (t: string) => t.split(' ').filter(Boolean).map((w) => normaliseName(w)!);
  if (s.includes(',')) {
    const [lastRaw = '', rest = ''] = s.split(',').map((x) => x.trim());
    const last = normaliseName(lastRaw);
    const parts = words(rest);
    if (!last || parts.length === 0) return null;
    return { firstName: parts[0]!, middleNames: parts.slice(1).join(' ') || null, lastName: last, guessed: false };
  }
  const parts = words(s);
  if (parts.length < 2) return null;
  return { firstName: parts[0]!, middleNames: parts.slice(1, -1).join(' ') || null, lastName: parts[parts.length - 1]!, guessed: true };
}
