import { Inject, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { APP_CONFIG, type AppConfig } from '../common/config';
import type { FieldCrypto } from './field-crypto';

/**
 * AES-256-GCM envelope encryption for sensitive columns (`*_enc bytea`).
 *
 * Ciphertext layout (all binary, stored as bytea):
 *   [0]      format version (0x01)
 *   [1]      master key id (1..255) that wrapped the data key  → key rotation
 *   [2..13]  IV for the data-key wrap (12 bytes)
 *   [14..29] GCM tag of the wrap (16 bytes)
 *   [30..61] wrapped per-record data key (32 bytes)
 *   [62..73] IV for the payload (12 bytes)
 *   [74..89] GCM tag of the payload (16 bytes)
 *   [90..]   payload ciphertext
 * The 2-byte header is bound as AAD to the data-key wrap, so the key id cannot be swapped; the payload is
 * authenticated by its own GCM tag under the per-record data key.
 *
 * Rotation re-wraps only the 32-byte data key under the newest master key (see `rewrap`, cli/rotate-keys.ts);
 * the payload is never re-encrypted.
 *
 * Blind index: HMAC-SHA256 with a separate key (the `bidx:` line of the key file, or HKDF from the oldest master key
 * with a distinct `info`). It does not change when master keys rotate.
 *
 * Key file (SMS_MASTER_KEY_FILE), one entry per line, `#` comments allowed:
 *   1:<base64 32 bytes>
 *   2:<base64 32 bytes>      ← the highest id is the active key for new encryptions
 *   bidx:<base64 32 bytes>   ← optional, recommended
 */
export const FORMAT_VERSION = 0x01;
const HEADER = 2;
const IV = 12;
const TAG = 16;
const DEK = 32;
const MIN_LEN = HEADER + IV + TAG + DEK + IV + TAG;
const PAYLOAD_AAD = Buffer.from('sms-field-v1');

export interface KeyRing {
  keys: Map<number, Buffer>;
  activeKeyId: number;
  blindIndexKey: Buffer;
}

export function parseKeyFile(content: string): KeyRing {
  const keys = new Map<number, Buffer>();
  let bidx: Buffer | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(bidx|\d{1,3}):([A-Za-z0-9+/=]+)$/.exec(line);
    if (!m) throw new Error('Master key file: each line must look like "<id>:<base64 key>" or "bidx:<base64 key>"');
    const key = Buffer.from(m[2]!, 'base64');
    if (key.length !== 32) throw new Error('Master key file: every key must be exactly 32 bytes (base64 of 32 random bytes)');
    if (m[1] === 'bidx') {
      bidx = key;
    } else {
      const id = Number(m[1]);
      if (id < 1 || id > 255) throw new Error('Master key file: key ids must be between 1 and 255');
      if (keys.has(id)) throw new Error(`Master key file: key id ${id} appears twice`);
      keys.set(id, key);
    }
  }
  if (keys.size === 0) throw new Error('Master key file contains no keys');
  const ids = [...keys.keys()].sort((a, b) => a - b);
  const blindIndexKey = bidx ?? Buffer.from(hkdfSync('sha256', keys.get(ids[0]!)!, Buffer.alloc(0), 'sms-blind-index-v1', 32));
  return { keys, activeKeyId: ids[ids.length - 1]!, blindIndexKey };
}

export function generateKeyLine(id: number | 'bidx'): string {
  return `${id}:${randomBytes(32).toString('base64')}`;
}

export class FieldCryptoEngine implements FieldCrypto {
  constructor(private readonly ring: KeyRing) {}

  get activeKeyId(): number {
    return this.ring.activeKeyId;
  }

  encrypt(plaintext: string): Buffer {
    const header = Buffer.from([FORMAT_VERSION, this.ring.activeKeyId]);
    const dek = randomBytes(DEK);
    const payloadIv = randomBytes(IV);
    const pc = createCipheriv('aes-256-gcm', dek, payloadIv);
    pc.setAAD(PAYLOAD_AAD);
    const body = Buffer.concat([pc.update(plaintext, 'utf8'), pc.final()]);
    const payloadTag = pc.getAuthTag();
    const wrapped = this.wrap(header, dek);
    dek.fill(0);
    return Buffer.concat([header, wrapped, payloadIv, payloadTag, body]);
  }

  decrypt(ciphertext: Buffer): string {
    const { dek } = this.unwrap(ciphertext);
    try {
      const off = HEADER + IV + TAG + DEK;
      const d = createDecipheriv('aes-256-gcm', dek, ciphertext.subarray(off, off + IV));
      d.setAAD(PAYLOAD_AAD);
      d.setAuthTag(ciphertext.subarray(off + IV, off + IV + TAG));
      return Buffer.concat([d.update(ciphertext.subarray(off + IV + TAG)), d.final()]).toString('utf8');
    } catch {
      throw new Error('Encrypted value failed authentication (wrong key or tampered data)');
    } finally {
      dek.fill(0);
    }
  }

  blindIndex(value: string): Buffer {
    return createHmac('sha256', this.ring.blindIndexKey).update(value, 'utf8').digest();
  }

  /** Derives a stable purpose-specific secret (e.g. CSRF HMAC key) that survives master-key rotation. */
  deriveKey(info: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.ring.blindIndexKey, Buffer.alloc(0), `sms-derived:${info}`, 32));
  }

  keyIdOf(ciphertext: Buffer): number {
    this.checkShape(ciphertext);
    return ciphertext[1]!;
  }

  /** Re-wraps the data key under the active master key. Returns the same buffer if it already uses it. */
  rewrap(ciphertext: Buffer): Buffer {
    if (this.keyIdOf(ciphertext) === this.ring.activeKeyId) return ciphertext;
    const { dek } = this.unwrap(ciphertext);
    const header = Buffer.from([FORMAT_VERSION, this.ring.activeKeyId]);
    const wrapped = this.wrap(header, dek);
    dek.fill(0);
    return Buffer.concat([header, wrapped, ciphertext.subarray(HEADER + IV + TAG + DEK)]);
  }

  private wrap(header: Buffer, dek: Buffer): Buffer {
    const key = this.ring.keys.get(header[1]!)!;
    const iv = randomBytes(IV);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(header);
    const wrapped = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), wrapped]);
  }

  private unwrap(ciphertext: Buffer): { header: Buffer; dek: Buffer } {
    this.checkShape(ciphertext);
    const header = ciphertext.subarray(0, HEADER);
    const key = this.ring.keys.get(header[1]!);
    if (!key) throw new Error(`Encrypted value uses master key id ${header[1]}, which is not in the key file`);
    try {
      const d = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(HEADER, HEADER + IV));
      d.setAAD(header);
      d.setAuthTag(ciphertext.subarray(HEADER + IV, HEADER + IV + TAG));
      const dek = Buffer.concat([d.update(ciphertext.subarray(HEADER + IV + TAG, HEADER + IV + TAG + DEK)), d.final()]);
      return { header, dek };
    } catch {
      throw new Error('Encrypted value failed authentication (wrong key or tampered data)');
    }
  }

  private checkShape(ciphertext: Buffer): void {
    if (ciphertext.length < MIN_LEN || ciphertext[0] !== FORMAT_VERSION) {
      throw new Error('Not a recognised encrypted value');
    }
  }
}

/** Loads the key ring from SMS_MASTER_KEY_FILE. Production refuses to start without it or with loose file permissions. */
export function loadKeyRing(cfg: Pick<AppConfig, 'SMS_MASTER_KEY_FILE' | 'SMS_NODE_ENV'>, logger?: Logger): KeyRing {
  const path = cfg.SMS_MASTER_KEY_FILE;
  if (!path) {
    if (cfg.SMS_NODE_ENV === 'production') throw new Error('SMS_MASTER_KEY_FILE is required in production');
    logger?.warn('SMS_MASTER_KEY_FILE not set: using a temporary random key. Encrypted data will be unreadable after restart.');
    return parseKeyFile(`${generateKeyLine(1)}\n${generateKeyLine('bidx')}`);
  }
  if (cfg.SMS_NODE_ENV === 'production' && process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) throw new Error(`Master key file ${path} must not be readable by group or others (chmod 400)`);
  }
  return parseKeyFile(readFileSync(path, 'utf8'));
}

@Injectable()
export class EnvelopeFieldCrypto extends FieldCryptoEngine {
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    super(loadKeyRing(cfg, new Logger('FieldCrypto')));
  }
}
