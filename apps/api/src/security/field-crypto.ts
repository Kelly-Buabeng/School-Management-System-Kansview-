/** Field-level encryption (AES-256-GCM envelope) and blind index. Real implementation: Agent D. */
export interface FieldCrypto {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  /** Deterministic HMAC for equality lookups (e.g. Ghana Card). Normalise input before calling. */
  blindIndex(value: string): Buffer;
}
export const FIELD_CRYPTO = Symbol('FIELD_CRYPTO');
