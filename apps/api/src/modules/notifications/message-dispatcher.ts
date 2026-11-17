// Owner: Agent F. Writes messages + message_recipients and queues one pg-boss job per deliverable recipient.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { earliestSendTime } from './quiet-hours';
import { BossService } from './queue/boss.service';

export interface DraftRecipient {
  guardianId?: string | null;
  studentId?: string | null;
  phone: string;
  body: string;
  /** Guardian has receives_sms = false: stored as skipped_opt_out, never sent. */
  optedOut?: boolean;
}

export interface DraftMessage {
  kind: string;
  channel: 'sms' | 'whatsapp';
  templateId: string | null;
  preview: string;
  audience: Record<string, unknown>;
  recipients: DraftRecipient[];
  requestedBy: string | null;
  /** Bulk message waiting for an approver: rows are written but no jobs are queued until approval. */
  needsApproval: boolean;
  scheduledFor?: Date | null;
  dedupeKey?: string | null;
}

export interface CreatedMessage {
  messageId: string;
  status: 'pending_approval' | 'queued' | 'done';
  deduplicated: boolean;
  queued: number;
  skippedOptOut: number;
}

export const isEmergencyKind = (kind: string): boolean => kind === 'emergency';

@Injectable()
export class MessageDispatcher {
  private readonly logger = new Logger('MessageDispatcher');
  /** Overridable clock for tests. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly boss: BossService,
  ) {}

  async create(draft: DraftMessage, outerTx?: Tx): Promise<CreatedMessage> {
    // Start pg-boss before the transaction so its first-time schema setup never runs inside our transaction.
    await this.boss.get();
    const run = async (tx: Tx): Promise<CreatedMessage> => {
      const skipped = draft.recipients.filter((r) => r.optedOut).length;
      const deliverable = draft.recipients.length - skipped;
      const status = draft.needsApproval ? 'pending_approval' : deliverable === 0 ? 'done' : 'queued';
      const inserted = await tx.insertInto('messages')
        .values({
          kind: draft.kind,
          channel: draft.channel,
          template_id: draft.templateId,
          body_rendered_preview: draft.preview,
          audience: JSON.stringify(draft.audience),
          status,
          recipient_count: draft.recipients.length,
          requested_by: draft.requestedBy,
          created_by: draft.requestedBy,
          scheduled_for: draft.scheduledFor ?? null,
          dedupe_key: draft.dedupeKey ?? null,
        })
        .onConflict((oc) => oc.column('dedupe_key').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) {
        const existing = await tx.selectFrom('messages').select(['id', 'status']).where('dedupe_key', '=', draft.dedupeKey!).executeTakeFirstOrThrow();
        this.logger.debug(`duplicate message suppressed (${draft.dedupeKey})`);
        return { messageId: existing.id, status: existing.status as CreatedMessage['status'], deduplicated: true, queued: 0, skippedOptOut: 0 };
      }
      const messageId = inserted.id;
      if (draft.recipients.length) {
        const rows = await tx.insertInto('message_recipients')
          .values(draft.recipients.map((r) => ({
            message_id: messageId,
            guardian_id: r.guardianId ?? null,
            student_id: r.studentId ?? null,
            phone: r.phone,
            body: r.body,
            status: r.optedOut ? 'skipped_opt_out' as const : 'queued' as const,
            created_by: draft.requestedBy,
          })))
          .returning(['id', 'status'])
          .execute();
        if (!draft.needsApproval) {
          const startAfter = this.startAfter(draft.kind, draft.scheduledFor ?? null);
          for (const r of rows) if (r.status === 'queued') await this.boss.sendSms({ recipientId: r.id }, startAfter, tx);
        }
      }
      return { messageId, status, deduplicated: false, queued: draft.needsApproval ? 0 : deliverable, skippedOptOut: skipped };
    };
    return outerTx ? run(outerTx) : this.db.transaction().execute(run);
  }

  /** Queues every still-queued recipient of an approved (or retried) message. */
  async queueRecipients(messageId: string, tx: Tx, recipientIds?: string[]): Promise<number> {
    await this.boss.get();
    const msg = await tx.selectFrom('messages').select(['kind', 'scheduled_for']).where('id', '=', messageId).executeTakeFirstOrThrow();
    let q = tx.selectFrom('message_recipients').select('id').where('message_id', '=', messageId).where('status', '=', 'queued');
    if (recipientIds) q = q.where('id', 'in', recipientIds.length ? recipientIds : ['00000000-0000-0000-0000-000000000000']);
    const rows = await q.execute();
    const startAfter = this.startAfter(msg.kind, msg.scheduled_for ? new Date(msg.scheduled_for) : null);
    for (const r of rows) await this.boss.sendSms({ recipientId: r.id }, startAfter, tx);
    return rows.length;
  }

  private startAfter(kind: string, scheduledFor: Date | null): Date {
    const now = this.now();
    const base = scheduledFor && scheduledFor.getTime() > now.getTime() ? scheduledFor : now;
    return earliestSendTime(base, isEmergencyKind(kind));
  }

  /** Sets messages.status from its recipients: sending → done / partially_failed once nothing is queued. */
  async refreshStatus(messageId: string, tx: Tx): Promise<void> {
    await sql`
      UPDATE messages m SET status = CASE
          WHEN c.queued > 0 THEN 'sending'::message_status
          WHEN c.failed > 0 THEN 'partially_failed'::message_status
          ELSE 'done'::message_status END
      FROM (SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'failed') AS failed
            FROM message_recipients WHERE message_id = ${messageId}) c
      WHERE m.id = ${messageId} AND m.status IN ('queued', 'sending', 'done', 'partially_failed')`.execute(tx);
  }
}
