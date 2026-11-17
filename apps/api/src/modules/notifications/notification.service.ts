// Owner: Agent F. NotificationService contract implementation used by other modules (absence alerts, fee reminders,
// password reset). Never sends synchronously: rows + pg-boss jobs commit together and the worker delivers.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import type { EnqueueOptions, NotificationRecipient, NotificationService, TemplateCode } from '../../common/contracts';
import { KYSELY, type Db } from '../../common/db/database.module';
import { MessageDispatcher, type DraftRecipient } from './message-dispatcher';
import { renderTemplate } from './template-engine';

/** Used when the school has not stored a template for a code (password_reset has no seeded template). */
export const DEFAULT_TEMPLATE_BODIES: Record<TemplateCode, string> = {
  fee_reminder: 'Dear {{guardianName}}, {{studentName}} ({{studentCode}}) has an outstanding balance of {{balance}}. Kindly pay by {{dueDate}}. Thank you. {{schoolName}}',
  absence_alert: 'Dear {{guardianName}}, {{studentName}} was marked absent from school today, {{date}}. Please call {{schoolPhone}} if you were not aware. {{schoolName}}',
  announcement: '{{schoolName}}: {{message}}',
  closure_notice: '{{schoolName}}: The school will be closed on {{date}}. {{message}}',
  emergency: 'URGENT from {{schoolName}}: {{message}} Please call {{schoolPhone}}.',
  password_reset: '{{schoolName}}: your password reset code is {{code}}. It expires in {{minutes}} minutes. Do not share it.',
};

const E164 = /^\+[1-9]\d{7,14}$/;

@Injectable()
export class QueueNotificationService implements NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly dispatcher: MessageDispatcher,
  ) {}

  async schoolContext(): Promise<{ schoolName: string; schoolPhone: string }> {
    const sp = await this.db.selectFrom('school_profile').select(['name', 'phone']).executeTakeFirst();
    return { schoolName: sp?.name ?? '', schoolPhone: sp?.phone ?? '' };
  }

  async templateFor(code: TemplateCode, channel: 'sms' | 'whatsapp'): Promise<{ id: string | null; body: string }> {
    const t = await this.db.selectFrom('message_templates').select(['id', 'body'])
      .where('code', '=', code).where('channel', '=', channel).where('is_active', '=', true).executeTakeFirst();
    return t ?? { id: null, body: DEFAULT_TEMPLATE_BODIES[code] };
  }

  /** Guardians who opted out (receives_sms = false) for the given student, or for all their children when no student. */
  async optedOutGuardians(pairs: Array<{ guardianId: string; studentId?: string | null }>): Promise<Set<string>> {
    const ids = [...new Set(pairs.map((p) => p.guardianId))];
    if (!ids.length) return new Set();
    const links = await this.db.selectFrom('student_guardians').select(['guardian_id', 'student_id', 'receives_sms'])
      .where('guardian_id', 'in', ids).execute();
    const out = new Set<string>();
    for (const p of pairs) {
      const mine = links.filter((l) => l.guardian_id === p.guardianId && (!p.studentId || l.student_id === p.studentId));
      if (mine.length && mine.every((l) => !l.receives_sms)) out.add(p.studentId ? `${p.guardianId}:${p.studentId}` : p.guardianId);
    }
    return out;
  }

  async enqueue(
    template: TemplateCode,
    recipients: NotificationRecipient[],
    context: Record<string, string | number>,
    opts: EnqueueOptions = {},
  ): Promise<{ messageId: string }> {
    const channel = opts.channel ?? 'sms';
    if (channel === 'whatsapp') throw new AppError(422, 'NOT_IMPLEMENTED', 'WhatsApp messages are not available yet');
    for (const r of recipients) {
      if (!E164.test(r.phone)) throw new AppError(400, 'VALIDATION_FAILED', 'Phone number must be in +233 format', r.phone);
    }
    const [tpl, school] = await Promise.all([this.templateFor(template, channel), this.schoolContext()]);
    const ctx = { ...school, ...context };
    const { text, missing } = renderTemplate(tpl.body, ctx);
    if (missing.length) this.logger.warn({ template, missing }, 'message rendered with empty placeholders');

    // Emergencies reach everyone; other messages respect the guardian's SMS opt-out.
    const optedOut = template === 'emergency'
      ? new Set<string>()
      : await this.optedOutGuardians(recipients.filter((r) => r.guardianId).map((r) => ({ guardianId: r.guardianId!, studentId: r.studentId })));
    const drafts: DraftRecipient[] = recipients.map((r) => ({
      guardianId: r.guardianId ?? null,
      studentId: r.studentId ?? null,
      phone: r.phone,
      body: text,
      optedOut: !!r.guardianId && (optedOut.has(r.guardianId) || optedOut.has(`${r.guardianId}:${r.studentId}`)),
    }));
    const res = await this.dispatcher.create({
      kind: template,
      channel,
      templateId: tpl.id,
      preview: text,
      audience: { type: 'system', recipients: recipients.length },
      recipients: drafts,
      requestedBy: opts.requestedByUserId ?? null,
      needsApproval: false,
      scheduledFor: opts.scheduledFor ? new Date(opts.scheduledFor) : null,
      dedupeKey: opts.dedupeKey ?? null,
    });
    return { messageId: res.messageId };
  }
}
