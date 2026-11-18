import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldCryptoEngine, generateKeyLine, loadKeyRing, parseKeyFile } from './field-crypto.service';

const k1 = generateKeyLine(1);
const k2 = generateKeyLine(2);
const bidx = generateKeyLine('bidx');

describe('FieldCrypto (AES-256-GCM envelope)', () => {
  const engine = new FieldCryptoEngine(parseKeyFile(`${k1}\n${bidx}`));

  it('round-trips text including Unicode', () => {
    for (const s of ['', 'Severe peanut allergy, carries EpiPen', 'GHA-123456789-0', 'Ɛwiase ɔdɔ 😀']) {
      expect(engine.decrypt(engine.encrypt(s))).toBe(s);
    }
  });

  it('uses a fresh data key and IV per record (same input, different ciphertext)', () => {
    const a = engine.encrypt('asthma');
    const b = engine.encrypt('asthma');
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(a[1]).toBe(1);
    expect(a.toString('latin1')).not.toContain('asthma');
  });

  it('detects tampering anywhere in the ciphertext', () => {
    const c = engine.encrypt('sickle cell disease');
    for (const pos of [5, 40, 70, c.length - 1]) {
      const t = Buffer.from(c);
      t[pos] = t[pos]! ^ 0x01;
      expect(() => engine.decrypt(t)).toThrow(/authentication/);
    }
  });

  it('refuses swapped key ids and unknown formats', () => {
    const c = engine.encrypt('x');
    const swapped = Buffer.from(c);
    swapped[1] = 2;
    expect(() => engine.decrypt(swapped)).toThrow(/key id 2/);
    expect(() => engine.decrypt(Buffer.from('plain text value that is long enough to pass the length check.................................'))).toThrow(/Not a recognised/);
  });

  it('blind index is deterministic, keyed, and independent of the encryption key', () => {
    const a = engine.blindIndex('GHA-123456789-0');
    expect(a.equals(engine.blindIndex('GHA-123456789-0'))).toBe(true);
    expect(a.equals(engine.blindIndex('GHA-123456789-1'))).toBe(false);
    const other = new FieldCryptoEngine(parseKeyFile(`${k1}\n${generateKeyLine('bidx')}`));
    expect(a.equals(other.blindIndex('GHA-123456789-0'))).toBe(false);
    expect(a).toHaveLength(32);
  });

  it('key rotation: new key becomes active, old data still decrypts, rewrap moves it to the new key', () => {
    const before = engine.encrypt('diabetic, insulin at 12:00');
    const rotated = new FieldCryptoEngine(parseKeyFile(`${k1}\n${k2}\n${bidx}`));
    expect(rotated.activeKeyId).toBe(2);
    expect(rotated.decrypt(before)).toBe('diabetic, insulin at 12:00');
    expect(rotated.keyIdOf(rotated.encrypt('new'))).toBe(2);

    const rewrapped = rotated.rewrap(before);
    expect(rotated.keyIdOf(rewrapped)).toBe(2);
    expect(rotated.rewrap(rewrapped)).toBe(rewrapped);
    // after rewrap the old key can be retired
    const retired = new FieldCryptoEngine(parseKeyFile(`${k2}\n${bidx}`));
    expect(retired.decrypt(rewrapped)).toBe('diabetic, insulin at 12:00');
    expect(() => retired.decrypt(before)).toThrow(/key id 1/);
    // blind index unchanged by rotation (explicit bidx key)
    expect(retired.blindIndex('X').equals(engine.blindIndex('X'))).toBe(true);
  });

  it('derives a stable blind-index key from the oldest master key when no bidx line exists', () => {
    const a = new FieldCryptoEngine(parseKeyFile(k1));
    const b = new FieldCryptoEngine(parseKeyFile(`${k1}\n${k2}`));
    expect(a.blindIndex('v').equals(b.blindIndex('v'))).toBe(true);
  });

  it('validates the key file', () => {
    expect(() => parseKeyFile('')).toThrow(/no keys/);
    expect(() => parseKeyFile('1:abc')).toThrow(/32 bytes/);
    expect(() => parseKeyFile(`${k1}\n${k1}`)).toThrow(/twice/);
    expect(() => parseKeyFile('hello')).toThrow(/each line/);
    expect(() => parseKeyFile(`# comment\n\n${k1}`)).not.toThrow();
  });

  it('loadKeyRing: requires a key file in production and refuses loose permissions', () => {
    expect(() => loadKeyRing({ SMS_NODE_ENV: 'production', SMS_MASTER_KEY_FILE: undefined })).toThrow(/required/);
    expect(loadKeyRing({ SMS_NODE_ENV: 'test', SMS_MASTER_KEY_FILE: undefined }).keys.size).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'd-keys-'));
    const file = join(dir, 'master.key');
    writeFileSync(file, `${k1}\n${bidx}\n`);
    chmodSync(file, 0o644);
    expect(() => loadKeyRing({ SMS_NODE_ENV: 'production', SMS_MASTER_KEY_FILE: file })).toThrow(/chmod 400/);
    chmodSync(file, 0o400);
    expect(loadKeyRing({ SMS_NODE_ENV: 'production', SMS_MASTER_KEY_FILE: file }).activeKeyId).toBe(1);
  });
});
