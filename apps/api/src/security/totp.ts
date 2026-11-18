import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticator } from 'otplib';

/**
 * TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with a ±1 step window for phone clock drift,
 * plus replay protection (a code that was accepted cannot be used again) and one-time recovery codes.
 */
const STEP_SECONDS = 30;
authenticator.options = { step: STEP_SECONDS, window: 1, digits: 6 };

export const TOTP_ISSUER = 'Kansview SMS';

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20); // 160-bit secret, base32
}

export function totpKeyUri(username: string, secret: string, issuer = TOTP_ISSUER): string {
  return authenticator.keyuri(username, issuer, secret);
}

/** For tests and enrolment previews. */
export function currentTotp(secret: string): string {
  return authenticator.generate(secret);
}

/**
 * Verifies a TOTP code. Returns the absolute time step that matched, or null.
 * `lastUsedStep` is the step of the last accepted code for this user; codes at or before it are rejected (replay).
 */
export function verifyTotp(code: string, secret: string, lastUsedStep: number | null, now = Date.now()): number | null {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const delta = authenticator.checkDelta(token, secret);
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / STEP_SECONDS) + delta;
  if (lastUsedStep !== null && step <= lastUsedStep) return null;
  return step;
}

/**
 * Remembers the last accepted TOTP step per user. In-memory is enough for one API process
 * (single-server deployment); entries expire after the TOTP window.
 */
export class TotpReplayGuard {
  private readonly last = new Map<string, { step: number; at: number }>();
  get(userId: string): number | null {
    const e = this.last.get(userId);
    if (!e) return null;
    if (Date.now() - e.at > STEP_SECONDS * 3 * 1000) {
      this.last.delete(userId);
      return null;
    }
    return e.step;
  }
  set(userId: string, step: number): void {
    this.last.set(userId, { step, at: Date.now() });
  }
}

// ---------------- Recovery codes ----------------

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i confusion
export const RECOVERY_CODE_COUNT = 10;

/** Codes look like `k7mq-4xpz-9ha2` (about 59 bits each). Show once; store only hashes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(12);
    let s = '';
    for (const b of bytes) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`);
  }
  return codes;
}

function normaliseRecovery(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** SHA-256 is enough here: the codes are long random values, not human-chosen passwords. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(`sms-recovery:${normaliseRecovery(code)}`).digest('hex');
}

/** Returns the remaining hashes if the code matched one (that hash removed), else null. Constant time per comparison. */
export function consumeRecoveryCode(code: string, hashes: readonly string[]): string[] | null {
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  let matchIndex = -1;
  hashes.forEach((h, i) => {
    const stored = Buffer.from(h, 'hex');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate) && matchIndex === -1) matchIndex = i;
  });
  if (matchIndex === -1) return null;
  return hashes.filter((_, i) => i !== matchIndex);
}

export function looksLikeRecoveryCode(code: string): boolean {
  return normaliseRecovery(code).length === 12 && !/^\d+$/.test(code.trim());
}
