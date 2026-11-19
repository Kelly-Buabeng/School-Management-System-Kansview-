import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../common/app-error';
import { KYSELY, type Db } from '../common/db/database.module';
import type { AuthUser } from './auth-user';
import type { IdempotencyService, IdempotentResult } from './idempotency';

/** Canonical JSON (sorted keys) so that key order does not change the request hash. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function requestHash(route: string, body: unknown): string {
  return createHash('sha256').update(`${route}\n${stableStringify(body)}`).digest('hex');
}

/**
 * Idempotency-Key handling on app.idempotency_records (unique per user, route, key).
 * 1. A claim row (response_status NULL = "in progress") is committed first. A concurrent request with the same key
 *    gets 409 "already being processed"; a later one replays the stored response (or 422 if the body differs).
 * 2. `fn` runs with its own business transaction (no connection is held while it runs, so 100 parallel payments
 *    cannot exhaust the pool).
 * 3. On success (2xx) the response is stored; on failure or non-2xx the claim is deleted so the user can retry.
 * Money endpoints also keep their own unique idempotency column (e.g. payments.idempotency_key), so a crash between
 * steps 2 and 3 cannot create a duplicate payment.
 * 4. Crash recovery: if the API dies after step 1 (power cut, kill -9), the claim would block the key for ever. A retry
 *    with the SAME request that finds a claim older than STALE_CLAIM_MS with no stored response takes the claim over
 *    (one atomic UPDATE, so only one retry wins) and runs `fn` again. Every idempotent operation must therefore also be
 *    safe to re-run at the database level (payments replay by payments.idempotency_key; invoice generation skips
 *    invoiced students; promotion commit and import commit are re-runnable).
 */
/** A claim with no response after this long belongs to a request whose process died (requests finish in seconds). */
export const STALE_CLAIM_MS = 2 * 60_000;

@Injectable()
export class DbIdempotencyService implements IdempotencyService {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async run<T>(key: string | undefined, route: string, body: unknown, user: AuthUser, fn: () => Promise<{ status: number; body: T }>): Promise<IdempotentResult<T>> {
    if (!key) throw new AppError(400, ErrorCodes.IDEMPOTENCY_KEY_REQUIRED, 'Missing Idempotency-Key header', 'Refresh the page and try again.');
    if (key.length < 16 || key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(key)) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid Idempotency-Key header', 'Use 16 to 128 letters, digits or dashes.');
    }
    const hash = requestHash(route, body);
    const claimed = await this.db.insertInto('idempotency_records')
      .values({ key, user_id: user.id, route, request_hash: hash })
      .onConflict((oc) => oc.columns(['user_id', 'route', 'key']).doNothing())
      .returning('id').executeTakeFirst();
    let claimId = claimed?.id;
    if (!claimId) {
      const row = await this.find(user.id, route, key);
      if (!row) throw new AppError(409, ErrorCodes.VERSION_CONFLICT, 'This request is still being processed. Wait a minute or two, then try again.');
      const takenOver = row.response_status === null && row.request_hash === hash ? await this.takeOverStaleClaim(row.id) : undefined;
      if (!takenOver) return this.replay<T>(row, hash);
      claimId = takenOver;
    }
    const claimedId = claimId;
    let result: { status: number; body: T };
    try {
      result = await fn();
    } catch (e) {
      await this.db.deleteFrom('idempotency_records').where('id', '=', claimedId).execute();
      throw e;
    }
    if (result.status >= 200 && result.status < 300) {
      await this.db.updateTable('idempotency_records')
        .set({ response_status: result.status, response_body: JSON.stringify(result.body ?? null) })
        .where('id', '=', claimedId).execute();
    } else {
      await this.db.deleteFrom('idempotency_records').where('id', '=', claimedId).execute();
    }
    return { ...result, replayed: false };
  }

  /** Deletes records older than 7 days (retention per schema.md). Called by a daily job. */
  async purgeExpired(days = 7): Promise<number> {
    const r = await this.db.deleteFrom('idempotency_records').where('created_at', '<', new Date(Date.now() - days * 86_400_000)).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /** Atomically re-claims an abandoned "in progress" record; returns its id only for the single winner. */
  private async takeOverStaleClaim(id: string): Promise<string | undefined> {
    const r = await this.db.updateTable('idempotency_records')
      .set({ created_at: new Date() })
      .where('id', '=', id).where('response_status', 'is', null)
      .where('created_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
      .returning('id').executeTakeFirst();
    return r?.id;
  }

  private find(userId: string, route: string, key: string) {
    return this.db.selectFrom('idempotency_records').select(['id', 'request_hash', 'response_status', 'response_body'])
      .where('user_id', '=', userId).where('route', '=', route).where('key', '=', key).executeTakeFirst();
  }

  private replay<T>(row: { request_hash: string; response_status: number | null; response_body: unknown }, hash: string): IdempotentResult<T> {
    if (row.request_hash !== hash) {
      throw new AppError(422, ErrorCodes.IDEMPOTENCY_KEY_REUSED, 'This request key was already used for different details',
        'Refresh the page to start a new entry.');
    }
    if (row.response_status === null) {
      throw new AppError(409, ErrorCodes.VERSION_CONFLICT, 'This request is still being processed. Wait a minute or two, then try again.');
    }
    return { status: row.response_status, body: row.response_body as T, replayed: true };
  }
}
