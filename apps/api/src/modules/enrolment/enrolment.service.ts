// Owner: Agent B. Enrolment history (never overwritten), class changes, class rolls and roll numbers.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { fullNameSql } from '../settings/common/db';
import { zDate, zUuid } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { alphabeticalRoll } from '../students/admission-rules';
import { reservePlace } from '../students/admission.service';
import { StudentReader } from '../students/student-reader';

export const ChangeClassBody = z.strictObject({
  classId: zUuid,
  effectiveDate: zDate.optional(),
  reason: z.string().trim().min(3).max(300),
});
export const RenumberBody = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('alphabetical') }),
  z.strictObject({ mode: z.literal('manual'), studentIds: z.array(zUuid).min(1).max(500) }),
]);

@Injectable()
export class EnrolmentService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    private readonly access: RecordAccess,
    private readonly reader: StudentReader,
  ) {}

  async history(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId, { includeArchived: true });
    const rows = await this.db.selectFrom('enrolments as e').innerJoin('classes as c', 'c.id', 'e.class_id').innerJoin('academic_years as y', 'y.id', 'e.academic_year_id')
      .select(['e.id', 'e.class_id', 'c.display_name', 'e.academic_year_id', 'y.name', 'e.roll_number', 'e.start_date', 'e.end_date', 'e.status', 'e.reason', 'e.promotion_run_id'])
      .where('e.student_id', '=', s.id).orderBy('e.start_date').orderBy('e.created_at').execute();
    return rows.map((r) => ({
      id: r.id, classId: r.class_id, className: r.display_name, academicYearId: r.academic_year_id, academicYear: r.name, rollNumber: r.roll_number,
      startDate: r.start_date, endDate: r.end_date, status: r.status, reason: r.reason, promotionRunId: r.promotion_run_id,
    }));
  }

  /** Closes the open enrolment and opens a new one in the chosen class (capacity checked). */
  async changeClass(rawId: string, body: z.infer<typeof ChangeClassBody>, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    if (s.status !== 'active') throw new AppError(422, ErrorCodes.ENROLMENT_CONFLICT, 'Only active students can change class');
    await this.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('enrolments').selectAll().where('student_id', '=', s.id).where('end_date', 'is', null).forUpdate().executeTakeFirst();
      if (!cur) throw new AppError(422, ErrorCodes.ENROLMENT_CONFLICT, 'This student is not in a class at the moment');
      if (cur.class_id === body.classId) throw new AppError(422, ErrorCodes.ENROLMENT_CONFLICT, 'The student is already in this class');
      const target = await tx.selectFrom('classes').select(['academic_year_id']).where('id', '=', body.classId).executeTakeFirst();
      if (!target) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'The chosen class was not found');
      if (target.academic_year_id !== cur.academic_year_id) {
        throw new AppError(422, ErrorCodes.ENROLMENT_CONFLICT, 'Choose a class in the same academic year', 'Moving to next year is done with a promotion run.');
      }
      const date = body.effectiveDate ?? todayInAccra();
      if (date < cur.start_date) throw new AppError(422, ErrorCodes.ENROLMENT_CONFLICT, `The change date cannot be before ${cur.start_date}, when the current class started`);
      const place = await reservePlace(tx, body.classId);
      await tx.updateTable('enrolments').set({ end_date: date, status: 'moved', updated_by: user.id }).where('id', '=', cur.id).execute();
      const n = await tx.insertInto('enrolments').values({
        student_id: s.id, class_id: body.classId, academic_year_id: cur.academic_year_id, roll_number: place.rollNumber, start_date: date,
        status: 'active', reason: body.reason, created_by: user.id, updated_by: user.id,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record({ action: 'update', entityType: 'enrolment', entityId: n.id, studentId: s.id, changes: { classId: { before: cur.class_id, after: body.classId } }, reason: body.reason }, user, tx);
    });
    return this.history(s.id, user);
  }

  async classStudents(rawClassId: string, user: AuthUser) {
    const c = await this.access.classInScope(user, rawClassId);
    const rows = await this.reader.base().select(this.reader.summaryColumns()).select(['s.first_name', 's.last_name', 's.gender', 's.date_of_birth', 'e.id as enrolment_id', 'e.start_date'])
      .where('e.class_id', '=', c.id).orderBy('e.roll_number').orderBy('s.last_name').execute();
    return {
      class: { id: c.id, displayName: c.displayName, capacity: c.capacity, enrolledCount: rows.length },
      students: rows.map((r) => ({ ...this.reader.toSummary(r), firstName: r.first_name, lastName: r.last_name, gender: r.gender, dateOfBirth: r.date_of_birth, enrolmentId: r.enrolment_id, startDate: r.start_date })),
    };
  }

  async renumber(rawClassId: string, body: z.infer<typeof RenumberBody>, user: AuthUser) {
    const c = await this.access.classInScope(user, rawClassId);
    await this.db.transaction().execute(async (tx) => {
      await tx.selectFrom('classes').select('id').where('id', '=', c.id).forUpdate().execute();
      const order = await this.order(tx, c.id, body);
      await tx.updateTable('enrolments').set({ roll_number: null }).where('class_id', '=', c.id).where('end_date', 'is', null).execute();
      for (const o of order) await tx.updateTable('enrolments').set({ roll_number: o.rollNumber, updated_by: user.id }).where('id', '=', o.enrolmentId).execute();
      await this.audit.record({ action: 'update', entityType: 'class_roll', entityId: c.id, changes: { mode: { after: body.mode }, count: { after: order.length } } }, user, tx);
    });
    return this.classStudents(c.id, user);
  }

  private async order(tx: Tx, classId: string, body: z.infer<typeof RenumberBody>) {
    const rows = await tx.selectFrom('enrolments as e').innerJoin('students as s', 's.id', 'e.student_id')
      .select(['e.id', 'e.student_id', 's.first_name', 's.last_name', 's.student_code', fullNameSql('s').as('n')])
      .where('e.class_id', '=', classId).where('e.end_date', 'is', null).execute();
    if (body.mode === 'alphabetical') {
      return alphabeticalRoll(rows.map((r) => ({ enrolmentId: r.id, firstName: r.first_name, lastName: r.last_name, studentCode: r.student_code })));
    }
    const ids = new Set(rows.map((r) => r.student_id));
    if (body.studentIds.length !== rows.length || new Set(body.studentIds).size !== rows.length || body.studentIds.some((id) => !ids.has(id))) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'List every student in the class exactly once', `The class has ${rows.length} students.`);
    }
    return body.studentIds.map((sid, i) => ({ enrolmentId: rows.find((r) => r.student_id === sid)!.id, rollNumber: i + 1 }));
  }
}

export { sql };
