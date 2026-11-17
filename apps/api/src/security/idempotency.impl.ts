import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../common/app-error';
import { KYSELY, type Db, type Tx } from '../common/db/database.module';
import type { AuthUser } from './auth-user';
import type { IdempotencyService, IdempotentResult } from './idempotency';

const txStore = new AsyncLocalStorage<Tx>();

/**
 * The transaction holding the idempotency claim for the current `run()`.
 * Callers that do their business writes inside it get exactly-once semantics even across crashes:
 *   await idem.run(key, route, body, user, async () => {
 *     const tx = currentIdempotencyTx();           // may be undefined outside run()
 *     return (tx ? fn(tx) : db.transaction().execute(fn));
 *   });
 */
export function currentIdempotencyTx(): Tx | undefined {
  return txStore.getStore();
}

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
 * The claim row is inserted first inside a transaction; a concurrent request with the same key waits on the
 * unique index until the first one commits, then replays its stored response. Failures roll the claim back,
 * so a failed request can be retried with the same key. Only successful (2xx) responses are stored.
 */
@Injectable()
export class DbIdempotencyService implements IdempotencyService {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async run<T>(key: string | undefined, route: string, body: unknown, user: AuthUser, fn: () => Promise<{ status: number; body: T }>): Promise<IdempotentResult<T>> {
    if (!key) throw new AppError(400, ErrorCodes.IDEMPOTENCY_KEY_REQUIRED, 'Missing Idempotency-Key header', 'Refresh the page and try again.');
    if (key.length < 16 || key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(key)) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid Idempotency-Key header', 'Use 16 to 128 letters, digits or dashes.');
    }
    const hash = requestHash(route, body);

    const existing = await this.find(user.id, route, key);
    if (existing) return this.replay<T>(existing, hash);

    return this.db.transaction().execute(async (tx) => {
      const claimed = await tx.insertInto('idempotency_records')
        .values({ key, user_id: user.id, route, request_hash: hash })
        .onConflict((oc) => oc.columns(['user_id', 'route', 'key']).doNothing())
        .returning('id').executeTakeFirst();
      if (!claimed) {
        const row = await this.find(user.id, route, key);
        if (!row) throw new AppError(409, ErrorCodes.VERSION_CONFLICT, 'This request is already being processed. Please wait a moment.');
        return this.replay<T>(row, hash);
      }
      const result = await txStore.run(tx, fn);
      if (result.status >= 200 && result.status < 300) {
        await tx.updateTable('idempotency_records')
          .set({ response_status: result.status, response_body: JSON.stringify(result.body ?? null) })
          .where('id', '=', claimed.id).execute();
      } else {
        await tx.deleteFrom('idempotency_records').where('id', '=', claimed.id).execute();
      }
      return { ...result, replayed: false };
    });
  }

  /** Deletes records older than 7 days (retention per schema.md). Called by a daily job. */
  async purgeExpired(days = 7): Promise<number> {
    const r = await this.db.deleteFrom('idempotency_records').where('created_at', '<', new Date(Date.now() - days * 86_400_000)).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  private find(userId: string, route: string, key: string) {
    return this.db.selectFrom('idempotency_records').select(['request_hash', 'response_status', 'response_body'])
      .where('user_id', '=', userId).where('route', '=', route).where('key', '=', key).executeTakeFirst();
  }

  private replay<T>(row: { request_hash: string; response_status: number | null; response_body: unknown }, hash: string): IdempotentResult<T> {
    if (row.request_hash !== hash) {
      throw new AppError(422, ErrorCodes.IDEMPOTENCY_KEY_REUSED, 'This request key was already used for different details',
        'Refresh the page to start a new entry.');
    }
    if (row.response_status === null) {
      throw new AppError(409, ErrorCodes.VERSION_CONFLICT, 'This request is already being processed. Please wait a moment.');
    }
    return { status: row.response_status, body: row.response_body as T, replayed: true };
  }
}
