import { Inject, Injectable, Logger } from '@nestjs/common';
import { KYSELY, type Db } from '../common/db/database.module';
import { APP_CONFIG, type AppConfig } from '../common/config';
import type { AuthUser } from './auth-user';
import type { AuditEvent, AuditService } from './audit.service';
import { maskChanges } from './masking';
import { currentRequestContext } from './request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes audit.events (append-only; the DB trigger computes the SHA-256 hash chain).
 * - Pass the business transaction as `tx` so the event commits or rolls back with the change.
 *   If the audit insert fails, the error propagates and the business transaction rolls back.
 * - Sensitive values in `changes` are masked here (masking.ts), whatever the caller passed.
 * - ip, request id and session come from the request context.
 */
@Injectable()
export class DbAuditService implements AuditService {
  private readonly logger = new Logger('Audit');
  /**
   * Test mode only (SMS_NODE_ENV=test): a copy of events written by this process, so older test helpers that read
   * `events` from the scaffold stub keep working. Undefined in development and production. Prefer querying audit.events.
   */
  readonly events?: Array<AuditEvent & { actorId: string | null }>;

  constructor(@Inject(KYSELY) private readonly db: Db, @Inject(APP_CONFIG) cfg: AppConfig) {
    if (cfg.SMS_NODE_ENV === 'test') this.events = [];
  }

  async record(event: AuditEvent, actor: AuthUser | null, tx?: unknown): Promise<void> {
    const ctx = currentRequestContext();
    const who = actor ?? ctx?.user ?? null;
    const executor = isKysely(tx) ? tx : this.db;
    const changes = maskChanges(event.changes);
    await executor.insertInto('audit.events').values({
      actor_user_id: who?.id ?? null,
      actor_role: who ? who.roles.join(',') || null : null,
      session_id: who?.sessionId || null,
      ip: ctx?.ip ?? null,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      student_id: event.studentId && UUID.test(event.studentId) ? event.studentId : null,
      changes: changes ? JSON.stringify(changes) : null,
      reason: event.reason ?? null,
      request_id: ctx?.requestId ?? null,
    }).execute();
    this.events?.push({ ...event, changes: changes ?? undefined, actorId: who?.id ?? null });
    ctx?.audited.add(`${event.action}:${event.entityType}`);
    this.logger.debug(`${event.action} ${event.entityType} ${event.entityId ?? ''}`);
  }
}

function isKysely(x: unknown): x is Db {
  return typeof x === 'object' && x !== null && typeof (x as { insertInto?: unknown }).insertInto === 'function';
}
