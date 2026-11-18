import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import {
  consumeRecoveryCode, currentTotp, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode,
  looksLikeRecoveryCode, totpKeyUri, TotpReplayGuard, verifyTotp,
} from './totp';

describe('TOTP', () => {
  const secret = generateTotpSecret();

  it('produces an otpauth URI for authenticator apps', () => {
    const uri = totpKeyUri('kwame.admin', secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kansview%20SMS:kwame\.admin\?secret=[A-Z2-7]+/);
  });

  it('accepts the current code and rejects a wrong one', () => {
    expect(verifyTotp(currentTotp(secret), secret, null)).not.toBeNull();
    const wrong = currentTotp(secret) === '000000' ? '111111' : '000000';
    expect(verifyTotp(wrong, secret, null)).toBeNull();
    expect(verifyTotp('12345', secret, null)).toBeNull();
    expect(verifyTotp('abcdef', secret, null)).toBeNull();
  });

  it('rejects replay of an already used code', () => {
    const code = currentTotp(secret);
    const step = verifyTotp(code, secret, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(code, secret, step)).toBeNull();
  });

  it('tolerates one step of clock drift', () => {
    const prev = authenticator.clone({ epoch: Date.now() - 30_000 }).generate(secret);
    expect(verifyTotp(prev, secret, null)).not.toBeNull();
    const old = authenticator.clone({ epoch: Date.now() - 120_000 }).generate(secret);
    if (old !== currentTotp(secret) && old !== prev) expect(verifyTotp(old, secret, null)).toBeNull();
  });

  it('replay guard remembers the last step per user', () => {
    const g = new TotpReplayGuard();
    expect(g.get('u1')).toBeNull();
    g.set('u1', 42);
    expect(g.get('u1')).toBe(42);
    expect(g.get('u2')).toBeNull();
  });
});

describe('recovery codes', () => {
  it('generates 10 distinct readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });

  it('stores only hashes and each code works once', () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    expect(hashes.join()).not.toContain(codes[0]!.replace(/-/g, ''));
    const remaining = consumeRecoveryCode(codes[1]!.toUpperCase(), hashes);
    expect(remaining).toHaveLength(2);
    expect(consumeRecoveryCode(codes[1]!, remaining!)).toBeNull();
    expect(consumeRecoveryCode('zzzz-zzzz-zzzz', hashes)).toBeNull();
  });
});
