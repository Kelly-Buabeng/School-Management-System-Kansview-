import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id with the OWASP Password Storage Cheat Sheet baseline (m = 19 MiB, t = 2, p = 1).
 * Sized for the 2 vCPU / 4 GB minimum server: about 30-60 ms per hash.
 * Hashes made with weaker parameters are upgraded on the next successful login (needsRehash).
 */
export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordHasher {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password.normalize('NFKC'), ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password.normalize('NFKC'));
    } catch {
      // Malformed hash in the database: treat as a failed verification (logged by the caller as login_failed).
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }

  /** Spend the same time as a real verification when the user does not exist (prevents user enumeration by timing). */
  async dummyVerify(password: string): Promise<false> {
    this.dummyHash ??= argon2.hash('dummy-password-for-timing-only', ARGON2_OPTIONS);
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
