import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { KYSELY, type Db } from '../../common/db/database.module';
import type { Page } from '../../common/pagination';

export const ListAuditQuery = z.strictObject({
  actorUserId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  action: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  entityType: z.string().regex(/^[a-z_]{2,60}$/).optional(),
  entityId: z.string().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface AuditEventDto {
  id: number;
  occurredAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  ip: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  studentId: string | null;
  changes: unknown;
  reason: string | null;
  requestId: string | null;
}

export interface ChainVerification {
  intact: boolean;
  checkedEvents: number;
  firstBrokenId: number | null;
  problems: Array<{ id: number; problem: string }>;
  headHash: string | null;
  verifiedAt: string;
}

@Injectable()
export class AuditQueryService {
  private readonly logger = new Logger('AuditChain');

  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async list(q: z.infer<typeof ListAuditQuery>): Promise<Page<AuditEventDto>> {
    let base = this.db.selectFrom('audit.events as e');
    if (q.actorUserId) base = base.where('e.actor_user_id', '=', q.actorUserId);
    if (q.studentId) base = base.where('e.student_id', '=', q.studentId);
    if (q.action) base = base.where('e.action', '=', q.action);
    if (q.entityType) base = base.where('e.entity_type', '=', q.entityType);
    if (q.entityId) base = base.where('e.entity_id', '=', q.entityId);
    if (q.from) base = base.where('e.occurred_at', '>=', new Date(q.from));
    if (q.to) base = base.where('e.occurred_at', '<', new Date(q.to));
    const [rows, total] = await Promise.all([
      base.leftJoin('users as u', 'u.id', 'e.actor_user_id')
        .select(['e.id', 'e.occurred_at', 'e.actor_user_id', 'u.full_name', 'e.actor_role', 'e.ip', 'e.action', 'e.entity_type', 'e.entity_id', 'e.student_id', 'e.changes', 'e.reason', 'e.request_id'])
        .orderBy('e.id', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    return {
      page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0),
      data: rows.map((r) => ({
        id: Number(r.id), occurredAt: new Date(r.occurred_at).toISOString(), actorUserId: r.actor_user_id, actorName: r.full_name, actorRole: r.actor_role,
        ip: r.ip, action: r.action, entityType: r.entity_type, entityId: r.entity_id, studentId: r.student_id, changes: r.changes, reason: r.reason, requestId: r.request_id,
      })),
    };
  }

  /** Recomputes the SHA-256 chain in the database (audit.verify_chain). Also the hook for the daily job. */
  async verify(): Promise<ChainVerification> {
    const problems = await sql<{ id: string | number; problem: string }>`SELECT id, problem FROM audit.verify_chain(0)`.execute(this.db);
    const head = await this.db.selectFrom('audit.events').select(['hash', (eb) => eb.fn.countAll<string>().over().as('n')]).orderBy('id', 'desc').limit(1).executeTakeFirst();
    const list = problems.rows.map((p) => ({ id: Number(p.id), problem: p.problem }));
    return {
      intact: list.length === 0,
      checkedEvents: Number(head?.n ?? 0),
      firstBrokenId: list[0]?.id ?? null,
      problems: list.slice(0, 50),
      headHash: head?.hash ?? null,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Daily job hook (worker): verifies the chain and logs the head hash as an external anchor.
   * A broken chain is logged at error level so the monitoring alert fires (Agent H).
   */
  async verifyAndLog(): Promise<ChainVerification> {
    const r = await this.verify();
    if (r.intact) this.logger.log({ checkedEvents: r.checkedEvents, headHash: r.headHash }, 'audit chain intact');
    else this.logger.error({ firstBrokenId: r.firstBrokenId, problems: r.problems.length }, 'AUDIT CHAIN BROKEN: possible tampering');
    return r;
  }
}
