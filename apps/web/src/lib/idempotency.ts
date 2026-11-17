/** A new Idempotency-Key (contract: 16–128 chars). One per form opening; reused on every retry of that form. */
export function newIdempotencyKey(prefix = 'web'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}
