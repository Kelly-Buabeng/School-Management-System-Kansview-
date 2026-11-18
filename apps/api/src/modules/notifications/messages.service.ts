// Owner: Agent F. Business rules behind the `messages` endpoints.
import { Inject, Injectable } from '@nestjs/common';
import { formatCedis, maskPhone, type Pesewas } from '@sms/shared';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AppError } from '../../common/app-error';
import { LEDGER_SERVICE, STUDENT_LOOKUP, type LedgerService, type StudentLookup } from '../../common/contracts';
import { KYSELY, type Db } from '../../common/db/database.module';
import { pageOffset, type Page } from '../../common/pagination';
import { AUDIT_SERVICE, IDEMPOTENCY_SERVICE, SCOPE_SERVICE, type AuditService, type AuthUser, type IdempotencyService, type ScopeService } from '../../security';
import { MessageDispatcher, type DraftRecipient } from './message-dispatcher';
import type { CreateTemplateBody, ListMessagesQuery, ListRecipientsQuery, SendMessageBody, UpdateTemplateBody } from './messages.schemas';
import { QueueNotificationService } from './notification.service';
import { estimateCostPesewas, smsInfo } from './sms-encoding';
import { PLACEHOLDER_ALLOW_LIST, placeholdersIn, renderTemplate, validateTemplate } from './template-engine';

const DEFAULT_APPROVAL_THRESHOLD = 50;
/** Placeholders filled by the system for each recipient; `variables` cannot override them. */
const SYSTEM_KEYS = new Set(['guardianName', 'studentName', 'studentCode', 'className', 'balance', 'schoolName', 'schoolPhone']);
/** If the body uses any of these, each child gets their own SMS; otherwise one SMS per phone number. */
const PER_STUDENT_KEYS = new Set(['studentName', 'studentCode', 'className', 'balance']);

interface ResolvedRecipient extends DraftRecipient {
  ctx: Record<string, string>;
}

const moneyText = (p: Pesewas): string => `GHS ${formatCedis(p, { symbol: false })}`; // GSM-7 safe (no cedi sign)

@Injectable()
export class MessagesService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(STUDENT_LOOKUP) private readonly students: StudentLookup,
    @Inject(LEDGER_SERVICE) private readonly ledger: LedgerService,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IdempotencyService,
    private readonly dispatcher: MessageDispatcher,
    private readonly notifications: QueueNotificationService,
  ) {}

  // ------------------------------------------------------------------ templates
  private templateDto(t: { id: string; code: string; channel: string; name: string; body: string; is_active: boolean; version: number; updated_at: Date | string }) {
    const info = smsInfo(t.body);
    return {
      id: t.id, code: t.code, channel: t.channel, name: t.name, body: t.body, isActive: t.is_active, version: t.version,
      placeholders: placeholdersIn(t.body), allowedPlaceholders: PLACEHOLDER_ALLOW_LIST[t.code as keyof typeof PLACEHOLDER_ALLOW_LIST] ?? [],
      encoding: info.encoding, updatedAt: new Date(t.updated_at).toISOString(),
    };
  }

  async listTemplates() {
    const rows = await this.db.selectFrom('message_templates').selectAll().orderBy('code').orderBy('channel').execute();
    return { data: rows.map((r) => this.templateDto(r)) };
  }

  async createTemplate(body: z.infer<typeof CreateTemplateBody>, user: AuthUser) {
    validateTemplate(body.code, body.body);
    return this.db.transaction().execute(async (tx) => {
      const exists = await tx.selectFrom('message_templates').select('id').where('code', '=', body.code).where('channel', '=', body.channel).executeTakeFirst();
      if (exists) throw new AppError(409, 'VALIDATION_FAILED', 'A template for this message type already exists', 'Edit the existing template instead.');
      const row = await tx.insertInto('message_templates').values({
        code: body.code, channel: body.channel, name: body.name, body: body.body, is_active: body.isActive, created_by: user.id, updated_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'message_template', entityId: row.id, changes: { body: { after: row.body } } }, user, tx);
      return this.templateDto(row);
    });
  }

  async updateTemplate(id: string, body: z.infer<typeof UpdateTemplateBody>, ifMatch: string | undefined, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('message_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('template');
      if (ifMatch !== undefined && ifMatch.replace(/"/g, '') !== String(cur.version)) {
        throw new AppError(412, 'VERSION_CONFLICT', 'Someone else changed this template. Reload and try again.');
      }
      if (body.body !== undefined) validateTemplate(cur.code as never, body.body);
      const row = await tx.updateTable('message_templates').set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        updated_by: user.id,
        // bump_version trigger (Agent A) increments version
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      const changes: Record<string, { before?: unknown; after?: unknown }> = {};
      for (const [k, col] of [['name', 'name'], ['body', 'body'], ['isActive', 'is_active']] as const) {
        if (cur[col] !== row[col]) changes[k] = { before: cur[col], after: row[col] };
      }
      await this.audit.record({ action: 'update', entityType: 'message_template', entityId: id, changes }, user, tx);
      return this.templateDto(row);
    });
  }

  // ------------------------------------------------------------------ audience
  private assertCanSend(req: SendMessageBody, user: AuthUser): void {
    if (req.channel === 'whatsapp') throw new AppError(422, 'NOT_IMPLEMENTED', 'WhatsApp messages are not available yet', 'Please send by SMS.');
    if (req.kind === 'emergency' && !user.permissions.has('messages:emergency')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the administrator or headteacher can send emergency messages');
    }
    const bulk = ['class', 'level', 'school', 'defaulters'].includes(req.audience.type);
    if (bulk && !user.permissions.has('messages:bulk') && !user.permissions.has('messages:emergency')) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to send bulk messages');
    }
    // rbac.md: the bursar sends fee reminders only.
    const onlyBursar = user.roles.includes('BURSAR') && !user.roles.some((r) => r === 'ADMIN' || r === 'HEADTEACHER' || r === 'REGISTRAR');
    if (onlyBursar && req.kind !== 'fee_reminder') throw new AppError(403, 'FORBIDDEN', 'The bursar can only send fee reminders');
    if (['students', 'guardians', 'class', 'level'].includes(req.audience.type) && !req.audience.ids?.length) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose who should receive the message', undefined, [{ field: 'audience.ids', code: 'REQUIRED', message: 'Select at least one' }]);
    }
  }

  private async body(req: SendMessageBody): Promise<{ templateId: string | null; body: string }> {
    if (req.body) {
      validateTemplate(req.kind, req.body);
      return { templateId: req.templateId ?? null, body: req.body };
    }
    if (req.templateId) {
      const t = await this.db.selectFrom('message_templates').select(['id', 'code', 'body', 'is_active']).where('id', '=', req.templateId).executeTakeFirst();
      if (!t || !t.is_active) throw AppError.notFound('template');
      if (t.code !== req.kind) throw new AppError(422, 'VALIDATION_FAILED', 'This template is for a different kind of message');
      return { templateId: t.id, body: t.body };
    }
    const t = await this.notifications.templateFor(req.kind, req.channel);
    return { templateId: t.id, body: t.body };
  }

  private validateVariables(req: SendMessageBody): Record<string, string> {
    const vars = req.variables ?? {};
    const allowed = new Set(PLACEHOLDER_ALLOW_LIST[req.kind]);
    const bad = Object.keys(vars).filter((k) => !allowed.has(k) || SYSTEM_KEYS.has(k));
    if (bad.length) {
      throw new AppError(422, 'TEMPLATE_PLACEHOLDER_INVALID', 'Some message values cannot be used', `Not allowed: ${bad.join(', ')}`,
        bad.map((k) => ({ field: `variables.${k}`, code: 'UNKNOWN_PLACEHOLDER', message: `${k} cannot be set here` })));
    }
    return vars;
  }

  private async resolve(req: SendMessageBody, body: string, user: AuthUser): Promise<ResolvedRecipient[]> {
    const vars = this.validateVariables(req);
    const school = await this.notifications.schoolContext();
    const base = { ...vars, ...school };
    const a = req.audience;

    if (a.type === 'guardians') {
      const gs = await this.db.selectFrom('guardians').select(['id', 'title', 'first_name', 'last_name', 'phone_primary'])
        .where('id', 'in', a.ids!).where('archived_at', 'is', null).execute();
      if (gs.length !== new Set(a.ids).size) throw AppError.notFound('guardian');
      const opted = await this.notifications.optedOutGuardians(gs.map((g) => ({ guardianId: g.id })));
      return gs.map((g) => ({
        guardianId: g.id, studentId: null, phone: g.phone_primary, body: '', optedOut: req.kind !== 'emergency' && opted.has(g.id),
        ctx: { ...base, guardianName: [g.title, g.first_name, g.last_name].filter(Boolean).join(' ') },
      }));
    }

    let studentIds: string[];
    if (a.type === 'students') {
      studentIds = [...new Set(a.ids!)];
      for (const id of studentIds) if (!(await this.scope.canAccessStudent(user, id))) throw AppError.notFound('student');
    } else if (a.type === 'class') studentIds = await this.students.listActiveStudentIds({ classIds: a.ids });
    else if (a.type === 'level') studentIds = await this.students.listActiveStudentIds({ levelIds: a.ids });
    else if (a.type === 'school') studentIds = await this.students.listActiveStudentIds({ school: true });
    else studentIds = await this.students.listActiveStudentIds(a.ids?.length ? { classIds: a.ids } : { school: true });

    const needBalance = a.type === 'defaulters' || placeholdersIn(body).includes('balance');
    const owed = needBalance && studentIds.length ? await this.ledger.outstandingByStudent(studentIds) : new Map<string, Pesewas>();
    if (a.type === 'defaulters') studentIds = studentIds.filter((id) => (owed.get(id) ?? 0) > 0);
    if (!studentIds.length) return [];

    const studs = await this.db.selectFrom('students as s')
      .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null))
      .leftJoin('classes as c', 'c.id', 'e.class_id')
      .select(['s.id', 's.student_code', 's.first_name', 's.last_name', 's.preferred_name', 'c.display_name'])
      .where('s.id', 'in', studentIds).execute();
    if (a.type === 'students' && studs.length !== studentIds.length) throw AppError.notFound('student');
    const links = await this.db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .select(['sg.student_id', 'sg.guardian_id', 'sg.is_primary', 'sg.receives_sms', 'g.title', 'g.first_name', 'g.last_name', 'g.phone_primary'])
      .where('sg.student_id', 'in', studentIds).where('g.archived_at', 'is', null)
      .orderBy('sg.is_primary', 'desc').orderBy('g.last_name').execute();

    const perStudent = placeholdersIn(body).some((p) => PER_STUDENT_KEYS.has(p));
    const out: ResolvedRecipient[] = [];
    const seenPhones = new Set<string>();
    for (const s of studs) {
      let mine = links.filter((l) => l.student_id === s.id);
      if (a.primaryGuardianOnly) mine = mine.slice(0, 1); // primary first (ordered), else the first guardian
      for (const l of mine) {
        const key = perStudent ? `${l.phone_primary}:${s.id}` : l.phone_primary;
        if (seenPhones.has(key)) continue;
        seenPhones.add(key);
        const bal = owed.get(s.id);
        out.push({
          guardianId: l.guardian_id, studentId: s.id, phone: l.phone_primary, body: '',
          optedOut: req.kind !== 'emergency' && !l.receives_sms,
          ctx: {
            ...base,
            guardianName: [l.title, l.first_name, l.last_name].filter(Boolean).join(' '),
            studentName: `${s.preferred_name ?? s.first_name} ${s.last_name}`,
            studentCode: s.student_code,
            className: s.display_name ?? '',
            ...(bal !== undefined ? { balance: moneyText(bal) } : {}),
          },
        });
      }
    }
    return out;
  }

  private async approvalThreshold(): Promise<number> {
    const r = await this.db.selectFrom('settings').select('value').where('key', '=', 'messaging.bulk_approval_threshold').executeTakeFirst();
    const n = Number(r?.value);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_APPROVAL_THRESHOLD;
  }

  private async build(req: SendMessageBody, user: AuthUser) {
    this.assertCanSend(req, user);
    const { templateId, body } = await this.body(req);
    const recipients = await this.resolve(req, body, user);
    for (const r of recipients) r.body = renderTemplate(body, r.ctx).text;
    const deliverable = recipients.filter((r) => !r.optedOut);
    const threshold = await this.approvalThreshold();
    const needsApproval = req.kind !== 'emergency' && deliverable.length > threshold && !user.permissions.has('messages:bulk_approve');
    const segments = deliverable.map((r) => smsInfo(r.body).segments);
    const totalSegments = segments.reduce((a, b) => a + b, 0);
    return { templateId, body, recipients, deliverable, threshold, needsApproval, segments, totalSegments };
  }

  async preview(req: SendMessageBody, user: AuthUser) {
    const b = await this.build(req, user);
    const sample = b.deliverable[0]?.body ?? renderTemplate(b.body, {}).text;
    const info = smsInfo(sample);
    return {
      recipientCount: b.deliverable.length,
      optedOutCount: b.recipients.length - b.deliverable.length,
      samples: b.deliverable.slice(0, 3).map((r) => ({ to: maskPhone(r.phone), body: r.body })),
      encoding: info.encoding,
      segmentsPerMessage: b.segments.length ? Math.max(...b.segments) : info.segments,
      totalSegments: b.totalSegments,
      estimatedCostPesewas: estimateCostPesewas(b.totalSegments),
      needsApproval: b.needsApproval,
      approvalThreshold: b.threshold,
      quietHoursApply: req.kind !== 'emergency',
    };
  }

  async send(req: SendMessageBody, idempotencyKey: string | undefined, user: AuthUser) {
    return this.idempotency.run(idempotencyKey, 'POST /messages', req, user, async () => {
      const b = await this.build(req, user);
      if (!b.recipients.length) throw new AppError(422, 'VALIDATION_FAILED', 'Nobody would receive this message', 'Check the audience: no guardian with a phone number was found.');
      const created = await this.db.transaction().execute(async (tx) => {
        const res = await this.dispatcher.create({
          kind: req.kind, channel: req.channel, templateId: b.templateId,
          preview: b.deliverable[0]?.body ?? b.recipients[0]!.body,
          audience: { type: req.audience.type, ids: req.audience.ids ?? [], primaryGuardianOnly: req.audience.primaryGuardianOnly },
          recipients: b.recipients, requestedBy: user.id, needsApproval: b.needsApproval,
          scheduledFor: req.scheduledFor ? new Date(req.scheduledFor) : null,
        }, tx);
        await this.audit.record({ action: 'create', entityType: 'message', entityId: res.messageId, changes: { kind: { after: req.kind }, recipients: { after: b.recipients.length }, status: { after: res.status } } }, user, tx);
        return res;
      });
      return {
        status: 202,
        body: {
          id: created.messageId, status: created.status, recipientCount: b.recipients.length, queued: created.queued, skippedOptOut: created.skippedOptOut,
          estimatedCostPesewas: estimateCostPesewas(b.totalSegments), needsApproval: b.needsApproval,
          ...(b.needsApproval ? { notice: { code: 'MESSAGE_NEEDS_APPROVAL', message: `More than ${b.threshold} recipients: the administrator must approve before it is sent.` } } : {}),
        },
      };
    });
  }

  // ------------------------------------------------------------------ read / approve / retry
  /** rbac.md: BURSAR and REGISTRAR see their own sends only. */
  private ownSendsOnly(user: AuthUser): boolean {
    return !user.roles.some((r) => r === 'ADMIN' || r === 'HEADTEACHER');
  }

  private async loadVisible(id: string, user: AuthUser) {
    const m = await this.db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirst();
    if (!m || (this.ownSendsOnly(user) && m.requested_by !== user.id)) throw AppError.notFound('message');
    return m;
  }

  private async counts(ids: string[]) {
    if (!ids.length) return new Map<string, Record<string, number>>();
    const rows = await this.db.selectFrom('message_recipients').select(['message_id', 'status', (eb) => eb.fn.countAll<string>().as('n'), (eb) => eb.fn.sum<string>('cost_units').as('cost')])
      .where('message_id', 'in', ids).groupBy(['message_id', 'status']).execute();
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const c = out.get(r.message_id) ?? { queued: 0, sent: 0, delivered: 0, failed: 0, skipped_opt_out: 0, costUnits: 0 };
      c[r.status] = Number(r.n);
      c.costUnits! += Number(r.cost ?? 0);
      out.set(r.message_id, c);
    }
    return out;
  }

  private messageDto(m: { id: string; kind: string; channel: string; status: string; body_rendered_preview: string | null; audience: unknown; recipient_count: number; requested_by: string | null; approved_by: string | null; approved_at: Date | string | null; scheduled_for: Date | string | null; created_at: Date | string }, c?: Record<string, number>) {
    const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
    return {
      id: m.id, kind: m.kind, channel: m.channel, status: m.status, preview: m.body_rendered_preview, audience: m.audience, recipientCount: m.recipient_count,
      requestedBy: m.requested_by, approvedBy: m.approved_by, approvedAt: iso(m.approved_at), scheduledFor: iso(m.scheduled_for), createdAt: iso(m.created_at),
      delivery: c ?? { queued: 0, sent: 0, delivered: 0, failed: 0, skipped_opt_out: 0, costUnits: 0 },
    };
  }

  async list(q: z.infer<typeof ListMessagesQuery>, user: AuthUser): Promise<Page<ReturnType<MessagesService['messageDto']>>> {
    let base = this.db.selectFrom('messages');
    if (q.status) base = base.where('status', '=', q.status);
    if (q.kind) base = base.where('kind', '=', q.kind);
    if (this.ownSendsOnly(user)) base = base.where('requested_by', '=', user.id);
    const { limit, offset } = pageOffset(q);
    const [total, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      base.selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).offset(offset).execute(),
    ]);
    const counts = await this.counts(rows.map((r) => r.id));
    return { data: rows.map((r) => this.messageDto(r, counts.get(r.id))), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
  }

  async get(id: string, user: AuthUser) {
    const m = await this.loadVisible(id, user);
    return this.messageDto(m, (await this.counts([id])).get(id));
  }

  async recipients(id: string, q: z.infer<typeof ListRecipientsQuery>, user: AuthUser) {
    await this.loadVisible(id, user);
    let base = this.db.selectFrom('message_recipients').where('message_id', '=', id);
    if (q.status) base = base.where('status', '=', q.status);
    const { limit, offset } = pageOffset(q);
    const [total, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      base.selectAll().orderBy('created_at').orderBy('id').limit(limit).offset(offset).execute(),
    ]);
    const attempts = rows.length ? await this.db.selectFrom('delivery_attempts').selectAll().where('recipient_id', 'in', rows.map((r) => r.id)).orderBy('attempt_no').execute() : [];
    const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
    return {
      data: rows.map((r) => ({
        id: r.id, guardianId: r.guardian_id, studentId: r.student_id, phone: maskPhone(r.phone), body: r.body, status: r.status,
        providerMessageId: r.provider_message_id, costUnits: r.cost_units, sentAt: iso(r.sent_at), deliveredAt: iso(r.delivered_at), lastError: r.last_error,
        attempts: attempts.filter((x) => x.recipient_id === r.id).map((x) => ({ attemptNo: x.attempt_no, attemptedAt: iso(x.attempted_at), provider: x.provider, responseCode: x.response_code, error: x.error })),
      })),
      page: q.page, pageSize: q.pageSize, total: Number(total.n),
    };
  }

  async approve(id: string, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('messages').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw AppError.notFound('message');
      if (m.status !== 'pending_approval') throw new AppError(409, 'VALIDATION_FAILED', 'This message is not waiting for approval');
      await tx.updateTable('messages').set({ status: 'queued', approved_by: user.id, approved_at: sql`now()`, updated_by: user.id }).where('id', '=', id).execute();
      const queued = await this.dispatcher.queueRecipients(id, tx);
      await this.audit.record({ action: 'approve', entityType: 'message', entityId: id, changes: { status: { before: 'pending_approval', after: 'queued' } } }, user, tx);
      return { id, status: 'queued', queued };
    });
  }

  async retryFailed(id: string, user: AuthUser) {
    await this.loadVisible(id, user);
    return this.db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('messages').select(['status']).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (m.status === 'pending_approval' || m.status === 'cancelled') throw new AppError(409, 'VALIDATION_FAILED', 'This message cannot be retried now');
      const rows = await tx.updateTable('message_recipients').set({ status: 'queued', last_error: null, updated_by: user.id })
        .where('message_id', '=', id).where('status', '=', 'failed').returning('id').execute();
      if (rows.length) {
        await tx.updateTable('messages').set({ status: 'sending', updated_by: user.id }).where('id', '=', id).execute();
        await this.dispatcher.queueRecipients(id, tx, rows.map((r) => r.id));
      }
      await this.audit.record({ action: 'update', entityType: 'message', entityId: id, changes: { retried: { after: rows.length } } }, user, tx);
      return { id, retried: rows.length };
    });
  }
}
