// Owner: Agent B. Daily class register, absence SMS (once per student per day, policy-gated), summaries.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db } from '../../common/db/database.module';
import { NOTIFICATION_SERVICE, STUDENT_LOOKUP, type NotificationService, type StudentLookup } from '../../common/contracts';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { fullNameSql, isoInstant } from '../settings/common/db';
import { zDate, zUuid } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { SettingsService } from '../settings/settings.service';

export const RegisterQuery = z.strictObject({ date: zDate, session: z.enum(['am', 'pm']).default('am') });
export const SaveRegisterBody = z.strictObject({
  records: z.array(z.strictObject({
    studentId: zUuid,
    status: z.enum(['present', 'absent', 'late', 'excused']),
    reasonCode: z.string().trim().max(40).optional(),
    note: z.string().trim().max(300).optional(),
  })).min(1).max(200),
});
export const SummaryQuery = z.strictObject({ from: zDate.optional(), to: zDate.optional(), classId: zUuid.optional(), format: z.enum(['json', 'xlsx', 'pdf']).default('json') });

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger('AttendanceService');
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService,
    @Inject(STUDENT_LOOKUP) private readonly students: StudentLookup,
    private readonly access: RecordAccess,
    private readonly settings: SettingsService,
  ) {}

  async register(rawClassId: string, q: z.infer<typeof RegisterQuery>, user: AuthUser) {
    const c = await this.access.classInScope(user, rawClassId);
    if (q.session === 'pm' && !(await this.settings.getPolicy('attendance.pm_session_enabled'))) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'The afternoon register is switched off in settings');
    const session = await this.db.selectFrom('attendance_sessions as s').leftJoin('users as u', 'u.id', 's.taken_by')
      .select(['s.id', 's.taken_at', 'u.full_name']).where('s.class_id', '=', c.id).where('s.date', '=', q.date).where('s.session', '=', q.session).executeTakeFirst();
    const roll = await this.db.selectFrom('enrolments as e').innerJoin('students as st', 'st.id', 'e.student_id')
      .leftJoin('attendance_records as r', (j) => j.onRef('r.student_id', '=', 'e.student_id').on('r.session_id', '=', session?.id ?? '00000000-0000-0000-0000-000000000000'))
      .select(['st.id', 'st.student_code', fullNameSql('st').as('full_name'), 'e.roll_number', 'r.status', 'r.reason_code', 'r.note', 'r.sms_message_id'])
      .where('e.class_id', '=', c.id).where('e.start_date', '<=', q.date).where((eb) => eb.or([eb('e.end_date', 'is', null), eb('e.end_date', '>=', q.date)]))
      .orderBy('e.roll_number').orderBy('st.last_name').execute();
    return {
      classId: c.id, className: c.displayName, date: q.date, session: q.session, taken: !!session, takenAt: isoInstant(session?.taken_at), takenBy: session?.full_name ?? null,
      records: roll.map((r) => ({ studentId: r.id, studentCode: r.student_code, fullName: r.full_name, rollNumber: r.roll_number, status: r.status ?? 'present', reasonCode: r.reason_code, note: r.note, smsSent: !!r.sms_message_id })),
    };
  }

  async save(rawClassId: string, q: z.infer<typeof RegisterQuery>, body: z.infer<typeof SaveRegisterBody>, user: AuthUser) {
    const c = await this.access.classInScope(user, rawClassId);
    if (q.date > todayInAccra()) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Attendance cannot be taken for a future date');
    const roll = await this.register(c.id, q, user);
    const enrolled = new Set(roll.records.map((r) => r.studentId));
    const outsider = body.records.find((r) => !enrolled.has(r.studentId));
    if (outsider) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'A student on the register is not in this class on that date', undefined, [{ field: 'records', code: 'NOT_ENROLLED', message: outsider.studentId }]);
    if (new Set(body.records.map((r) => r.studentId)).size !== body.records.length) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'A student is listed twice');

    const absent = await this.db.transaction().execute(async (tx) => {
      const session = await tx.insertInto('attendance_sessions').values({ class_id: c.id, date: q.date, session: q.session, taken_by: user.id, created_by: user.id, updated_by: user.id })
        .onConflict((oc) => oc.columns(['class_id', 'date', 'session']).doUpdateSet({ taken_by: user.id, taken_at: sql`now()`, updated_by: user.id }))
        .returning('id').executeTakeFirstOrThrow();
      for (const r of body.records) {
        const v = { status: r.status, reason_code: r.reasonCode ?? null, note: r.note ?? null, updated_by: user.id };
        await tx.insertInto('attendance_records').values({ session_id: session.id, student_id: r.studentId, ...v, created_by: user.id })
          .onConflict((oc) => oc.columns(['session_id', 'student_id']).doUpdateSet(v)).execute();
      }
      const counts = body.records.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
      await this.audit.record({ action: 'update', entityType: 'attendance_session', entityId: session.id, changes: { date: { after: q.date }, counts: { after: counts } } }, user, tx);
      return { sessionId: session.id, studentIds: body.records.filter((r) => r.status === 'absent').map((r) => r.studentId) };
    });
    await this.absenceSms(absent.sessionId, absent.studentIds, q.date, c.displayName, user);
    return this.register(c.id, q, user);
  }

  /** One SMS per absent student per day (any session), only when the policy is on. Failures are logged, never block the register. */
  private async absenceSms(sessionId: string, studentIds: string[], date: string, className: string, user: AuthUser) {
    if (!studentIds.length || !(await this.settings.getPolicy('attendance.sms_on_absence'))) return;
    const already = new Set((await this.db.selectFrom('attendance_records as r').innerJoin('attendance_sessions as s', 's.id', 'r.session_id')
      .select('r.student_id').where('s.date', '=', date).where('r.student_id', 'in', studentIds).where('r.sms_message_id', 'is not', null).execute()).map((r) => r.student_id));
    const school = await this.settings.getSchoolProfile();
    for (const sid of studentIds.filter((s) => !already.has(s))) {
      try {
        const recipients = await this.students.smsRecipients(sid, true);
        if (!recipients.length) continue;
        const info = await this.students.getBillingInfo(sid);
        const { messageId } = await this.notifications.enqueue('absence_alert', recipients.map((r) => ({ guardianId: r.guardianId, studentId: sid, phone: r.phone })),
          { studentName: info?.fullName ?? '', className, date, schoolName: school.name }, { dedupeKey: `absence:${sid}:${date}`, requestedByUserId: user.id });
        const exists = await this.db.selectFrom('messages').select('id').where('id', '=', messageId).executeTakeFirst();
        if (exists) await this.db.updateTable('attendance_records').set({ sms_message_id: messageId }).where('session_id', '=', sessionId).where('student_id', '=', sid).execute();
      } catch (err) {
        this.logger.error({ studentId: sid, date, err: (err as Error).message }, 'absence SMS could not be queued');
      }
    }
  }

  async summary(user: AuthUser, q: z.infer<typeof SummaryQuery>) {
    if (q.format !== 'json') throw new AppError(501, ErrorCodes.NOT_IMPLEMENTED, 'Spreadsheet and PDF attendance exports are not available yet');
    const to = q.to ?? todayInAccra();
    const from = q.from ?? to.slice(0, 8) + '01';
    const allowed = await this.access.allowedClassIds(user);
    if (q.classId) await this.access.classInScope(user, q.classId);
    if (allowed && allowed.length === 0) return { from, to, classes: [], students: [] };
    let base = this.db.selectFrom('attendance_records as r').innerJoin('attendance_sessions as s', 's.id', 'r.session_id').innerJoin('classes as c', 'c.id', 's.class_id')
      .where('s.date', '>=', from).where('s.date', '<=', to);
    if (q.classId) base = base.where('s.class_id', '=', q.classId);
    if (allowed) base = base.where('s.class_id', 'in', allowed);
    const agg = (col: 'c.id' | 'r.student_id') => base.select([col, sql<number>`count(*)::int`.as('total'),
      sql<number>`count(*) filter (where r.status in ('present','late'))::int`.as('present'),
      sql<number>`count(*) filter (where r.status = 'absent')::int`.as('absent'),
      sql<number>`count(*) filter (where r.status = 'late')::int`.as('late'),
      sql<number>`count(*) filter (where r.status = 'excused')::int`.as('excused')]).groupBy(col);
    const classes = await agg('c.id').select(sql<string>`min(c.display_name)`.as('name')).execute();
    const students = q.classId ? await agg('r.student_id').execute() : [];
    const names = students.length ? await this.db.selectFrom('students as s').select(['s.id', 's.student_code', fullNameSql('s').as('n')]).where('s.id', 'in', students.map((s) => s.student_id)).execute() : [];
    const rate = (p: number, t: number) => (t ? Math.round((p * 1000) / t) / 10 : null);
    return {
      from, to,
      classes: classes.map((c) => ({ classId: c.id, className: c.name, ...pick(c), ratePercent: rate(c.present, c.total) })),
      students: students.map((s) => { const n = names.find((x) => x.id === s.student_id); return { studentId: s.student_id, studentCode: n?.student_code, fullName: n?.n, ...pick(s), ratePercent: rate(s.present, s.total) }; })
        .sort((a, b) => (a.ratePercent ?? 0) - (b.ratePercent ?? 0)),
    };
  }
}

function pick(r: { total: number; present: number; absent: number; late: number; excused: number }) {
  return { total: r.total, present: r.present, absent: r.absent, late: r.late, excused: r.excused };
}
