import { randomHex } from './random';

/** A new Idempotency-Key (contract: 16–128 chars). One per form opening; reused on every retry of that form. */
export function newIdempotencyKey(prefix = 'web'): string {
  // randomUUID needs a secure context (HTTPS/localhost); fall back to getRandomValues, never Math.random.
  const uuid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : randomHex(16);
  return `${prefix}-${uuid}`;
}
