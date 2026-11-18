import { ErrorCodes } from '@sms/shared';
import { AppError } from '../common/app-error';
import { COMMON_PASSWORDS_RAW } from './data/common-passwords';

/**
 * Password policy (NIST SP 800-63B style):
 * - at least 12 characters, at most 256; spaces and any Unicode allowed, so passphrases work;
 * - no composition rules (no "must contain a symbol"), no forced rotation;
 * - rejected if it is (or is a trivial variation of) a commonly breached password, checked offline;
 * - rejected if it contains the username or the school name, or is one character / a short pattern repeated.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

let commonSet: Set<string> | null = null;
function common(): Set<string> {
  if (!commonSet) commonSet = new Set(COMMON_PASSWORDS_RAW.split('\n').filter((s) => s.length > 0));
  return commonSet;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** Strip leading/trailing digits, symbols and whitespace ("Password123!" → "password"). */
function core(s: string): string {
  return s.replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
}

function variants(pw: string): string[] {
  const lower = pw.normalize('NFKC').toLowerCase();
  const noSpace = lower.replace(/\s+/g, '');
  const deLeet = noSpace.replace(/[013457@$!]/g, (c) => LEET[c] ?? c);
  return [...new Set([lower, noSpace, core(noSpace), deLeet, core(deLeet)])].filter((v) => v.length >= 4);
}

function isRepetitive(pw: string): boolean {
  const s = pw.toLowerCase();
  // a unit of 1-4 characters repeated to fill the whole password ("aaaaaaaaaaaa", "abcabcabcabc")
  for (let n = 1; n <= 4; n++) {
    const unit = s.slice(0, n);
    if (unit.repeat(Math.ceil(s.length / n)).slice(0, s.length) === s) return true;
  }
  // straight sequences ("123456789012", "abcdefghijkl")
  let seq = true;
  for (let i = 1; i < s.length; i++) {
    if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== 1 && !(s[i - 1] === '9' && s[i] === '0')) {
      seq = false;
      break;
    }
  }
  return seq;
}

export interface PasswordContext {
  username?: string | null;
  fullName?: string | null;
  email?: string | null;
}

export interface PasswordCheck {
  ok: boolean;
  /** Plain-English reasons for school staff. */
  problems: string[];
}

export function checkPassword(password: string, ctx: PasswordContext = {}): PasswordCheck {
  const problems: string[] = [];
  const chars = [...password.normalize('NFKC')];
  if (chars.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters. A short sentence or three or four words works well.`);
  if (chars.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  if (problems.length === 0) {
    const set = common();
    if (variants(password).some((v) => set.has(v))) {
      problems.push('This password is too common and appears in lists of leaked passwords. Choose something else.');
    } else if (isRepetitive(password)) {
      problems.push('Do not use repeated characters or simple sequences.');
    }
    const lower = password.toLowerCase().replace(/\s+/g, '');
    const personal = [ctx.username, ctx.email?.split('@')[0], ...(ctx.fullName ?? '').split(/\s+/), 'kansview']
      .map((x) => (x ?? '').toLowerCase().trim())
      .filter((x) => x.length >= 4);
    if (personal.some((p) => lower.includes(p))) {
      problems.push('Do not include your name, username or the school name in your password.');
    }
  }
  return { ok: problems.length === 0, problems };
}

export function assertStrongPassword(password: string, ctx: PasswordContext = {}, field = 'newPassword'): void {
  const r = checkPassword(password, ctx);
  if (!r.ok) {
    throw new AppError(400, ErrorCodes.AUTH_PASSWORD_TOO_WEAK, 'Please choose a stronger password', r.problems.join(' '),
      r.problems.map((message) => ({ field, code: 'WEAK_PASSWORD', message })));
  }
}
