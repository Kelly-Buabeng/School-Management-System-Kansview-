import { describe, expect, it } from 'vitest';
import { assertStrongPassword, checkPassword } from './password-policy';
import { PasswordHasher } from './password-hasher';
import { AppError } from '../common/app-error';

describe('password policy', () => {
  it.each(['short pass', 'abc', ''])('rejects passwords shorter than 12 characters: %j', (pw) => {
    expect(checkPassword(pw).ok).toBe(false);
  });

  it.each(['password1234', 'Password123!', 'qwertyuiop12', 'P@ssw0rd2026', '123456789012', 'iloveyou1234', 'aaaaaaaaaaaaaa', 'abcabcabcabc', 'football2024!', 'KANSVIEW2026!!'])(
    'rejects common, breached or trivial passwords: %s',
    (pw) => {
      expect(checkPassword(pw).ok).toBe(false);
    },
  );

  it.each(['mango tree by the lagoon', 'kofi likes jollof on fridays', 'Red bicycle 47 kites', 'ɔdɔ yɛ dɛ paa ankasa'])('accepts passphrases without composition rules: %s', (pw) => {
    expect(checkPassword(pw)).toEqual({ ok: true, problems: [] });
  });

  it('does not require digits, symbols or upper case', () => {
    expect(checkPassword('quiet harmattan morning').ok).toBe(true);
  });

  it('rejects passwords containing the username or name', () => {
    expect(checkPassword('akosua.mensah garden', { username: 'akosua.mensah' }).ok).toBe(false);
    expect(checkPassword('mensahfamilytree', { fullName: 'Akosua Mensah' }).ok).toBe(false);
  });

  it('rejects passwords longer than 256 characters', () => {
    expect(checkPassword('x y '.repeat(100)).ok).toBe(false);
  });

  it('assertStrongPassword throws AUTH_PASSWORD_TOO_WEAK with field errors', () => {
    try {
      assertStrongPassword('password1234');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('AUTH_PASSWORD_TOO_WEAK');
      expect((e as AppError).errors?.[0]?.field).toBe('newPassword');
    }
  });
});

describe('PasswordHasher (Argon2id)', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id and OWASP parameters, verifies correctly', async () => {
    const h = await hasher.hash('mango tree by the lagoon');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(h, 'mango tree by the lagoon')).toBe(true);
    expect(await hasher.verify(h, 'mango tree by the lagoon ')).toBe(false);
    expect(hasher.needsRehash(h)).toBe(false);
  });

  it('normalises Unicode so the same passphrase typed differently verifies', async () => {
    const h = await hasher.hash('café au lait tonight');
    expect(await hasher.verify(h, 'café au lait tonight')).toBe(true);
  });

  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await hasher.verify('not-a-hash', 'whatever')).toBe(false);
  });

  it('flags weaker hashes for upgrade', async () => {
    const argon2 = await import('argon2');
    const weak = await argon2.hash('x', { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(hasher.needsRehash(weak)).toBe(true);
  });

  it('dummyVerify always returns false', async () => {
    expect(await hasher.dummyVerify('anything')).toBe(false);
  });
});
