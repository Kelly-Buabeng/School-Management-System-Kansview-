// Owner: Agent B. Score entry (with term lock), totals and grades, positions with ties, report cards (PDF via Agent F).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { PDF_SERVICE, type PdfService } from '../../common/contracts';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { fullNameSql, isoInstant, num } from '../settings/common/db';
import { parseId, zDate, zUuid } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { SettingsService } from '../settings/settings.service';
import { computeTotal, gradeFor, positionLabel, rankWithTies, round2, type GradingBand } from './grading';

export const ScoresQuery = z.strictObject({ termId: zUuid, subjectId: zUuid });
const score = z.number().min(0).max(100).multipleOf(0.01).nullable().optional();
export const SaveScoresBody = z.strictObject({
  scores: z.array(z.strictObject({ studentId: zUuid, classScore: score, examScore: score, subjectRemark: z.string().trim().max(200).nullable().optional() })).min(1).max(200),
});
export const GenerateBody = z.strictObject({ classId: zUuid, nextTermBegins: zDate.optional() });
export const ListCardsQuery = z.strictObject({ termId: zUuid, classId: zUuid.optional() });
export const RemarksBody = z.strictObject({
  classTeacherRemark: z.string().trim().max(500).nullable().optional(),
  headRemark: z.string().trim().max(500).nullable().optional(),
  conduct: z.string().trim().max(100).nullable().optional(),
  interest: z.string().trim().max(100).nullable().optional(),
  nextTermBegins: zDate.nullable().optional(),
});
export const PublishBody = z.strictObject({ termId: zUuid, classId: zUuid });
export const ClassPdfQuery = z.strictObject({ termId: zUuid, classId: zUuid });

const locked = () => new AppError(423, ErrorCodes.SCORES_LOCKED, 'Scores for this term are locked', 'Ask the headteacher to unlock them if a correction is needed.');

@Injectable()
export class AcademicsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(PDF_SERVICE) private readonly pdf: PdfService,
    private readonly access: RecordAccess,
    private readonly settings: SettingsService,
  ) {}

  private async term(rawId: string, tx?: Tx) {
    const t = await (tx ?? this.db).selectFrom('terms as t').innerJoin('academic_years as y', 'y.id', 't.academic_year_id')
      .select(['t.id', 't.name', 't.number', 't.start_date', 't.end_date', 't.academic_year_id', 'y.name as year_name']).where('t.id', '=', parseId(rawId, 'term')).executeTakeFirst();
    if (!t) throw AppError.notFound('term');
    return t;
  }

  private async isLocked(termId: string, tx?: Tx) {
    return !!(await (tx ?? this.db).selectFrom('term_scores').select('id').where('term_id', '=', termId).where('locked_at', 'is not', null).limit(1).executeTakeFirst());
  }

  async weights(levelId: string, tx?: Tx) {
    const rows = await (tx ?? this.db).selectFrom('assessment_config').select(['level_id', 'class_score_weight', 'exam_score_weight'])
      .where((eb) => eb.or([eb('level_id', '=', levelId), eb('level_id', 'is', null)])).execute();
    const r = rows.find((x) => x.level_id === levelId) ?? rows.find((x) => x.level_id === null);
    return { classScoreWeight: r?.class_score_weight ?? 30, examScoreWeight: r?.exam_score_weight ?? 70 };
  }

  async bands(levelId: string, tx?: Tx): Promise<GradingBand[]> {
    const db = tx ?? this.db;
    const scales = await db.selectFrom('grading_scales').select(['id', 'applies_to_level_ids', 'is_default']).execute();
    const scale = scales.find((s) => s.applies_to_level_ids.includes(levelId)) ?? scales.find((s) => s.is_default);
    if (!scale) return [];
    const b = await db.selectFrom('grading_bands').select(['min_score', 'max_score', 'grade', 'remark']).where('grading_scale_id', '=', scale.id).execute();
    return b.map((x) => ({ minScore: x.min_score, maxScore: x.max_score, grade: x.grade, remark: x.remark }));
  }

  async getScores(rawClassId: string, q: z.infer<typeof ScoresQuery>, user: AuthUser) {
    const c = await this.access.classInScope(user, rawClassId);
    const t = await this.term(q.termId);
    if (t.academic_year_id !== c.academicYearId) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'This term is not in the class\'s academic year');
    const rows = await this.db.selectFrom('enrolments as e').innerJoin('students as s', 's.id', 'e.student_id')
      .leftJoin('term_scores as ts', (j) => j.onRef('ts.student_id', '=', 'e.student_id').on('ts.term_id', '=', t.id).on('ts.subject_id', '=', q.subjectId))
      .select(['s.id', 's.student_code', fullNameSql('s').as('full_name'), 'e.roll_number', 'ts.class_score', 'ts.exam_score', 'ts.total', 'ts.grade', 'ts.subject_remark', 'ts.locked_at'])
      .where('e.class_id', '=', c.id).where('e.end_date', 'is', null).orderBy('e.roll_number').orderBy('s.last_name').execute();
    return {
      classId: c.id, termId: t.id, subjectId: q.subjectId, locked: await this.isLocked(t.id), ...(await this.weights(c.levelId)),
      scores: rows.map((r) => ({ studentId: r.id, studentCode: r.student_code, fullName: r.full_name, rollNumber: r.roll_number, classScore: num(r.class_score), examScore: num(r.exam_score), total: num(r.total), grade: r.grade, subjectRemark: r.subject_remark })),
    };
  }

  async saveScores(rawClassId: string, q: z.infer<typeof ScoresQuery>, body: z.infer<typeof SaveScoresBody>, user: AuthUser) {
    const c = await this.access.classInScope(user, rawClassId);
    const t = await this.term(q.termId);
    if (t.academic_year_id !== c.academicYearId) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'This term is not in the class\'s academic year');
    const subj = await this.db.selectFrom('subjects').select('id').where('id', '=', q.subjectId).executeTakeFirst();
    if (!subj) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Subject not found');
    const w = await this.weights(c.levelId);
    const bands = await this.bands(c.levelId);
    await this.db.transaction().execute(async (tx) => {
      if (await this.isLocked(t.id, tx)) throw locked();
      const enrolled = new Set((await tx.selectFrom('enrolments').select('student_id').where('class_id', '=', c.id).where('end_date', 'is', null).execute()).map((e) => e.student_id));
      for (const [i, s] of body.scores.entries()) {
        if (!enrolled.has(s.studentId)) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'A student is not in this class', undefined, [{ field: `scores.${i}.studentId`, code: 'NOT_ENROLLED', message: 'Not in this class' }]);
        let total: number | null;
        try { total = computeTotal(s.classScore ?? null, s.examScore ?? null, w); } catch (e) {
          throw new AppError(400, ErrorCodes.VALIDATION_FAILED, (e as Error).message, undefined, [{ field: `scores.${i}`, code: 'OUT_OF_RANGE', message: (e as Error).message }]);
        }
        const v = { class_score: s.classScore ?? null, exam_score: s.examScore ?? null, grade: gradeFor(total, bands)?.grade ?? null, ...(s.subjectRemark !== undefined && { subject_remark: s.subjectRemark }), entered_by: user.id, updated_by: user.id };
        await tx.insertInto('term_scores').values({ term_id: t.id, class_id: c.id, subject_id: q.subjectId, student_id: s.studentId, ...v, created_by: user.id })
          .onConflict((oc) => oc.columns(['term_id', 'subject_id', 'student_id']).doUpdateSet({ ...v, class_id: c.id })).execute();
      }
      await this.audit.record({ action: 'update', entityType: 'term_scores', entityId: `${t.id}:${q.subjectId}:${c.id}`, changes: { count: { after: body.scores.length } } }, user, tx);
    });
    return this.getScores(c.id, q, user);
  }

  async lock(rawTermId: string, user: AuthUser) {
    const t = await this.term(rawTermId);
    const n = await this.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('term_scores').set({ locked_at: sql`now()`, updated_by: user.id }).where('term_id', '=', t.id).where('locked_at', 'is', null).executeTakeFirst();
      await this.audit.record({ action: 'update', entityType: 'term_scores_lock', entityId: t.id, changes: { locked: { after: true } } }, user, tx);
      return Number(r.numUpdatedRows);
    });
    return { termId: t.id, locked: true, scoresLocked: n };
  }

  /** Totals, averages, positions (ties share a position, "joint 3rd") and attendance for one class; keeps remarks. */
  async generate(rawTermId: string, body: z.infer<typeof GenerateBody>, user: AuthUser) {
    const t = await this.term(rawTermId);
    const c = await this.access.classInScope(user, body.classId);
    if (t.academic_year_id !== c.academicYearId) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'This term is not in the class\'s academic year');
    return this.db.transaction().execute(async (tx) => {
      const students = await tx.selectFrom('enrolments').select('student_id').where('class_id', '=', c.id).where('end_date', 'is', null).execute();
      const scores = await tx.selectFrom('term_scores').select(['student_id', 'total']).where('term_id', '=', t.id).where('class_id', '=', c.id).execute();
      const att = await tx.selectFrom('attendance_records as r').innerJoin('attendance_sessions as s', 's.id', 'r.session_id')
        .select(['r.student_id', sql<number>`count(*)::int`.as('total'), sql<number>`count(*) filter (where r.status in ('present','late'))::int`.as('present')])
        .where('s.class_id', '=', c.id).where('s.date', '>=', t.start_date).where('s.date', '<=', t.end_date).groupBy('r.student_id').execute();
      const stats = students.map((s) => {
        const mine = scores.filter((x) => x.student_id === s.student_id && x.total !== null).map((x) => num(x.total)!);
        const overall = mine.length ? round2(mine.reduce((a, b) => a + b, 0)) : null;
        return { studentId: s.student_id, overall, average: overall === null ? null : round2(overall / mine.length) };
      });
      const ranked = rankWithTies(stats, (s) => s.average);
      let created = 0;
      let skipped = 0;
      for (const r of ranked) {
        const a = att.find((x) => x.student_id === r.item.studentId);
        const v = {
          class_id: c.id, overall_total: r.item.overall, average: r.item.average, position: r.position, position_tied: r.tied, class_size: students.length,
          attendance_present: a?.present ?? 0, attendance_total: a?.total ?? 0, ...(body.nextTermBegins && { next_term_begins: body.nextTermBegins }), updated_by: user.id,
        };
        const res = await tx.insertInto('report_cards').values({ term_id: t.id, student_id: r.item.studentId, ...v, created_by: user.id })
          .onConflict((oc) => oc.columns(['term_id', 'student_id']).doUpdateSet(v).where('report_cards.status', '=', 'draft')).executeTakeFirst();
        if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) created++; else skipped++;
      }
      await this.audit.record({ action: 'update', entityType: 'report_cards_generate', entityId: `${t.id}:${c.id}`, changes: { drafts: { after: created } } }, user, tx);
      return { termId: t.id, classId: c.id, generated: created, skippedPublished: skipped, classSize: students.length };
    });
  }

  private cards(db: Db | Tx = this.db) {
    return db.selectFrom('report_cards as rc').innerJoin('students as s', 's.id', 'rc.student_id').innerJoin('classes as c', 'c.id', 'rc.class_id')
      .selectAll('rc').select(['s.student_code', fullNameSql('s').as('student_name'), 'c.display_name as class_name']);
  }

  private cardDto(r: Awaited<ReturnType<ReturnType<AcademicsService['cards']>['executeTakeFirstOrThrow']>>) {
    return {
      id: r.id, termId: r.term_id, studentId: r.student_id, studentCode: r.student_code, studentName: r.student_name, classId: r.class_id, className: r.class_name,
      overallTotal: num(r.overall_total), average: num(r.average), position: r.position, positionTied: r.position_tied, positionLabel: positionLabel(r.position, r.position_tied),
      classSize: r.class_size, attendancePresent: r.attendance_present, attendanceTotal: r.attendance_total, conduct: r.conduct, interest: r.interest,
      classTeacherRemark: r.class_teacher_remark, headRemark: r.head_remark, nextTermBegins: r.next_term_begins, status: r.status, publishedAt: isoInstant(r.published_at), version: r.version,
    };
  }

  async list(user: AuthUser, q: z.infer<typeof ListCardsQuery>) {
    const allowed = await this.access.allowedClassIds(user);
    if (q.classId) await this.access.classInScope(user, q.classId);
    let query = this.cards().where('rc.term_id', '=', q.termId);
    if (q.classId) query = query.where('rc.class_id', '=', q.classId);
    if (allowed) query = allowed.length ? query.where('rc.class_id', 'in', allowed) : query.where(sql<boolean>`false`);
    return (await query.orderBy('c.display_name').orderBy(sql`rc.position nulls last`).orderBy('s.last_name').execute()).map((r) => this.cardDto(r));
  }

  private async card(user: AuthUser, rawId: string, tx?: Tx) {
    const r = await this.cards(tx).where('rc.id', '=', parseId(rawId, 'report card')).executeTakeFirst();
    if (!r) throw AppError.notFound('report card');
    const allowed = await this.access.allowedClassIds(user);
    if (allowed && !allowed.includes(r.class_id)) throw AppError.notFound('report card');
    return r;
  }

  async updateRemarks(rawId: string, body: z.infer<typeof RemarksBody>, user: AuthUser) {
    const canHead = user.roles.includes('HEADTEACHER') || user.roles.includes('ADMIN');
    if (body.headRemark !== undefined && !canHead) throw new AppError(403, ErrorCodes.FORBIDDEN, 'Only the headteacher can write the head\'s remark');
    await this.db.transaction().execute(async (tx) => {
      const r = await this.card(user, rawId, tx);
      if (r.status === 'published' && !canHead) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'This report card is already published');
      const map: Record<string, string> = { classTeacherRemark: 'class_teacher_remark', headRemark: 'head_remark', conduct: 'conduct', interest: 'interest', nextTermBegins: 'next_term_begins' };
      const set: Record<string, unknown> = { updated_by: user.id };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[map[k]!] = v;
      await tx.updateTable('report_cards').set(set as never).where('id', '=', r.id).execute();
      await this.audit.record({ action: 'update', entityType: 'report_card', entityId: r.id, studentId: r.student_id, changes: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, { after: v }])) }, user, tx);
    });
    return this.cardDto(await this.card(user, rawId));
  }

  async publish(body: z.infer<typeof PublishBody>, user: AuthUser) {
    await this.access.classInScope(user, body.classId);
    return this.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('report_cards').set({ status: 'published', published_at: sql`now()`, updated_by: user.id })
        .where('term_id', '=', body.termId).where('class_id', '=', body.classId).where('status', '=', 'draft').executeTakeFirst();
      const n = Number(r.numUpdatedRows);
      await this.audit.record({ action: 'update', entityType: 'report_cards_publish', entityId: `${body.termId}:${body.classId}`, changes: { published: { after: n } } }, user, tx);
      return { termId: body.termId, classId: body.classId, published: n };
    });
  }

  /** Data passed to the report_card PDF template (Agent F). */
  async pdfData(r: { id: string; term_id: string; student_id: string; class_id: string }) {
    const t = await this.term(r.term_id);
    const cls = await this.db.selectFrom('classes').select(['level_id']).where('id', '=', r.class_id).executeTakeFirstOrThrow();
    const subjects = await this.db.selectFrom('term_scores as ts').innerJoin('subjects as s', 's.id', 'ts.subject_id')
      .leftJoin('level_subjects as ls', (j) => j.onRef('ls.subject_id', '=', 'ts.subject_id').on('ls.level_id', '=', cls.level_id))
      .select(['s.name', 's.code', 'ts.class_score', 'ts.exam_score', 'ts.total', 'ts.grade', 'ts.subject_remark', 'ls.sort_order'])
      .where('ts.term_id', '=', r.term_id).where('ts.student_id', '=', r.student_id).orderBy(sql`ls.sort_order nulls last`).orderBy('s.name').execute();
    const bands = await this.bands(cls.level_id);
    const card = this.cardDto(await this.cards().where('rc.id', '=', r.id).executeTakeFirstOrThrow());
    const school = await this.settings.getSchoolProfile();
    return {
      school: { name: school.name, motto: school.motto, address: school.address, phone: school.phone, logoFileId: school.logoFileId },
      term: { name: t.name, number: t.number, academicYear: t.year_name, startDate: t.start_date, endDate: t.end_date },
      reportCard: card, weights: await this.weights(cls.level_id),
      subjects: subjects.map((s) => ({ name: s.name, code: s.code, classScore: num(s.class_score), examScore: num(s.exam_score), total: num(s.total), grade: s.grade, remark: s.subject_remark ?? bands.find((b) => b.grade === s.grade)?.remark ?? null })),
      gradingKey: bands,
    };
  }

  async cardPdf(rawId: string, user: AuthUser): Promise<{ pdf: Buffer; filename: string }> {
    const r = await this.card(user, rawId);
    const data = await this.pdfData(r);
    const pdf = await this.pdf.render('report_card', data, r.status === 'draft' ? { watermark: 'DRAFT' } : undefined);
    await this.audit.record({ action: 'export', entityType: 'report_card', entityId: r.id, studentId: r.student_id }, user);
    return { pdf, filename: `report-card-${r.student_code}.pdf` };
  }

  async classPdf(q: z.infer<typeof ClassPdfQuery>, user: AuthUser): Promise<{ pdf: Buffer; filename: string }> {
    const c = await this.access.classInScope(user, q.classId);
    const rows = await this.cards().where('rc.term_id', '=', q.termId).where('rc.class_id', '=', c.id).orderBy('s.last_name').execute();
    if (!rows.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No report cards have been generated for this class and term');
    const pages = [];
    for (const r of rows) pages.push(await this.pdfData(r));
    const pdf = await this.pdf.render('class_report_cards', { className: c.displayName, pages });
    await this.audit.record({ action: 'export', entityType: 'report_cards_class', entityId: `${q.termId}:${c.id}`, changes: { count: { after: rows.length } } }, user);
    return { pdf, filename: `report-cards-${c.displayName.replace(/\W+/g, '-')}.pdf` };
  }
}
