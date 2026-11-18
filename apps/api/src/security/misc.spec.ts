import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter';
import { maskChanges, maskObject, maskPhone, REDACTED } from './masking';
import { AppError } from '../common/app-error';

describe('RateLimiter', () => {
  it('allows up to the limit in the window, then refuses with retry-after', () => {
    const rl = new RateLimiter();
    const rule = { limit: 3, windowMs: 60_000 };
    const t0 = 1_000_000;
    expect(rl.consume('k', rule, t0).allowed).toBe(true);
    expect(rl.consume('k', rule, t0 + 1).allowed).toBe(true);
    expect(rl.consume('k', rule, t0 + 2).remaining).toBe(0);
    const d = rl.consume('k', rule, t0 + 3);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(60);
    expect(rl.consume('other', rule, t0 + 3).allowed).toBe(true);
    expect(rl.consume('k', rule, t0 + 60_001).allowed).toBe(true);
    rl.onModuleDestroy();
  });

  it('enforce throws 429 and sets Retry-After', () => {
    const rl = new RateLimiter();
    const headers: Record<string, string> = {};
    const res = { setHeader: (n: string, v: string) => (headers[n] = v) };
    rl.enforce('x', { limit: 1, windowMs: 1000 }, res, 0);
    expect(() => rl.enforce('x', { limit: 1, windowMs: 1000 }, res, 1)).toThrow(AppError);
    expect(headers['Retry-After']).toBe('1');
    rl.reset('x');
    expect(() => rl.enforce('x', { limit: 1, windowMs: 1000 }, res, 2)).not.toThrow();
    rl.onModuleDestroy();
  });
});

describe('masking', () => {
  it('masks phones but keeps them recognisable', () => {
    expect(maskPhone('+233244000123')).toBe('+233•••••123');
  });

  it('redacts secrets, medical text, Ghana Card and SSNIT; keeps ordinary fields', () => {
    const out = maskObject({
      firstName: 'Ama', password: 'x', passwordHash: 'y', mfaSecretEnc: Buffer.from('z'), ghanaCard: 'GHA-1', ssnitNo: 'C1',
      allergies: 'peanuts', medicationNotes: 'inhaler', phonePrimary: '+233244000123', nested: { token: 't', note: 'ok' },
    });
    expect(out).toEqual({
      firstName: 'Ama', password: REDACTED, passwordHash: REDACTED, mfaSecretEnc: REDACTED, ghanaCard: REDACTED, ssnitNo: REDACTED,
      allergies: REDACTED, medicationNotes: REDACTED, phonePrimary: '+233•••••123', nested: { token: REDACTED, note: 'ok' },
    });
  });

  it('masks audit change sets field by field', () => {
    expect(maskChanges({ allergies: { before: 'a', after: 'b' }, lastName: { before: 'Mensah', after: 'Owusu' }, roles: { after: ['ADMIN'] } })).toEqual({
      allergies: { before: REDACTED, after: REDACTED }, lastName: { before: 'Mensah', after: 'Owusu' }, roles: { after: ['ADMIN'] },
    });
    expect(maskChanges(undefined)).toBeNull();
  });
});
