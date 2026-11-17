import type { AuthUser } from './auth-user';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency-Key handling (idempotency_records table).
 * - same key + same request hash → returns the stored response (replayed: true)
 * - same key + different request hash → AppError 422 IDEMPOTENCY_KEY_REUSED
 * - new key → runs `fn` and stores the response in the same transaction as the business write when `tx` is given.
 * Real implementation: Agent D.
 */
export interface IdempotencyService {
  run<T>(
    key: string | undefined,
    route: string,
    requestBody: unknown,
    user: AuthUser,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>>;
}
export const IDEMPOTENCY_SERVICE = Symbol('IDEMPOTENCY_SERVICE');
