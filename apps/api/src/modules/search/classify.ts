// Owner: Agent B. Works out what a search box query probably is, so each group runs only the cheap, indexed query it needs.
import { normaliseGhanaPhone } from '@sms/shared';

export interface ClassifiedQuery {
  text: string;
  /** Upper-case student code or a prefix of one (e.g. "KSV-26-004"). */
  codePrefix: string | null;
  /** E.164 phone when the query is a full phone number. */
  phone: string | null;
  /** Digits-only fragment (≥4 digits) for phone "ends with"/receipt number matching. */
  digits: string | null;
  /** Upper-case receipt number or prefix ("RCP-0004"). */
  receiptPrefix: string | null;
  /** Class-like query, e.g. "P4", "JHS 2", "KG1 A". */
  classLike: string | null;
}

export function classifyQuery(raw: string): ClassifiedQuery {
  const text = raw.trim().replace(/\s+/g, ' ');
  const upper = text.toUpperCase();
  const digits = text.replace(/\D/g, '');
  const codePrefix = /^[A-Z]{3}-\d{0,2}(-\d{0,5}(-\d?)?)?$/.test(upper) && upper.length >= 4 ? upper : null;
  const receiptPrefix = /^(RCP|REV)-?\d*$/.test(upper) ? upper : null;
  const phone = /^[+\d\s()-]{9,16}$/.test(text) ? normaliseGhanaPhone(text) : null;
  const classLike = /^(CRECHE|NURSERY|KG ?\d|P ?\d|JHS ?\d|BASIC ?\d)( ?[A-Z])?$/.test(upper) ? upper.replace(/\s+/g, '') : null;
  return { text, codePrefix, phone, digits: digits.length >= 4 && /^[+\d\s()-]+$/.test(text) ? digits : null, receiptPrefix, classLike };
}

/** Escape LIKE wildcards in user input. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
