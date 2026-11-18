// Owner: Agent B. Academic years, terms, levels, classes, subjects, grading scales.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { constraintOf, isExclusionViolation, isFkViolation, isUniqueViolation, isoDate } from '../settings/common/db';
import { diffChanges as changes, parseId } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { validateBands } from '../academics/grading';
import type {
  CreateAcademicYearBody, CreateClassBody, CreateLevelBody, GradingScaleBody, UpdateAcademicYearBody, UpdateClassBody,
  UpdateLevelBody, UpdateTermBody,
} from './academic-setup.dto';

const conflict = (title: string, detail?: string) => new AppError(409, ErrorCodes.VALIDATION_FAILED, title, detail);
const invalid = (title: string, field?: string) =>
  new AppError(400, ErrorCodes.VALIDATION_FAILED, title, undefined, field ? [{ field, code: 'INVALID', message: title }] : undefined);

/** Maps database constraint failures to plain-English errors. Rethrows anything unexpected. */
function translate(e: unknown): never {
  if (isExclusionViolation(e, 'academic_years_no_overlap')) throw conflict('These dates overlap another academic year');
  if (isExclusionViolation(e, 'terms_no_overlap')) throw conflict('These term dates overlap another term');
  if (isExclusionViolation(e, 'grading_bands_no_overlap')) throw invalid('Two grade bands overlap', 'bands');
  if (isUniqueViolation(e)) {
    const c = constraintOf(e) ?? '';
    if (c.includes('academic_years_name')) throw conflict('An academic year with this name already exists');
    if (c.includes('levels_code')) throw conflict('A level with this code already exists');
    if (c.includes('levels_sort_order')) throw conflict('Another level already uses this position in the list');
    if (c.includes('classes_year_level_stream')) throw conflict('This class already exists for that year', 'Same level and stream.');
    if (c.includes('subjects_code')) throw conflict('A subject with this code already exists');
    if (c.includes('grading_scales_name')) throw conflict('A grading scale with this name already exists');
    if (c.includes('one_default')) throw conflict('Another grading scale is already the default');
    if (c.includes('one_class_teacher')) throw conflict('This class already has a class teacher');
    throw conflict('This record already exists');
  }
  if (isFkViolation(e)) throw invalid('A linked record (year, level, staff or subject) was not found');
  throw e;
}

@Injectable()
export class AcademicSetupService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    private readonly access: RecordAccess,
  ) {}

  // ---------------- academic years & terms ----------------
  async listYears() {
    const years = await this.db.selectFrom('academic_years').selectAll().orderBy('start_date', 'desc').execute();
    const terms = years.length
      ? await this.db.selectFrom('terms').selectAll().where('academic_year_id', 'in', years.map((y) => y.id)).orderBy('number').execute()
      : [];
    return years.map((y) => this.yearDto(y, terms.filter((t) => t.academic_year_id === y.id)));
  }

  async getYear(id: string, tx?: Tx) {
    const db = tx ?? this.db;
    const y = await db.selectFrom('academic_years').selectAll().where('id', '=', parseId(id, 'academic year')).executeTakeFirst();
    if (!y) throw AppError.notFound('academic year');
    const terms = await db.selectFrom('terms').selectAll().where('academic_year_id', '=', y.id).orderBy('number').execute();
    return this.yearDto(y, terms);
  }

  /** The current academic year id (or null when none is set). */
  async currentYearId(tx?: Tx): Promise<string | null> {
    const r = await (tx ?? this.db).selectFrom('academic_years').select('id').where('status', '=', 'current').executeTakeFirst();
    return r?.id ?? null;
  }

  async createYear(body: CreateAcademicYearBody, user: AuthUser) {
    if (body.endDate <= body.startDate) throw invalid('The year must end after it starts', 'endDate');
    const numbers = new Set(body.terms.map((t) => t.number));
    if (numbers.size !== 3) throw invalid('Give terms 1, 2 and 3 once each', 'terms');
    const terms = [...body.terms].sort((a, b) => a.number - b.number);
    for (const t of terms) {
      if (t.endDate <= t.startDate) throw invalid(`Term ${t.number} must end after it starts`, 'terms');
      if (t.startDate < body.startDate || t.endDate > body.endDate) throw invalid(`Term ${t.number} must fall inside the academic year`, 'terms');
    }
    for (let i = 1; i < terms.length; i++) if (terms[i]!.startDate <= terms[i - 1]!.endDate) throw invalid('Terms must not overlap and must be in order', 'terms');

    try {
      return await this.db.transaction().execute(async (tx) => {
        const y = await tx.insertInto('academic_years')
          .values({ name: body.name, start_date: body.startDate, end_date: body.endDate, created_by: user.id, updated_by: user.id })
          .returning('id').executeTakeFirstOrThrow();
        await tx.insertInto('terms').values(terms.map((t) => ({
          academic_year_id: y.id, number: t.number, name: t.name ?? `Term ${t.number}`, start_date: t.startDate, end_date: t.endDate,
          created_by: user.id, updated_by: user.id,
        }))).execute();
        await this.audit.record({ action: 'create', entityType: 'academic_year', entityId: y.id, changes: { name: { after: body.name } } }, user, tx);
        return this.getYear(y.id, tx);
      });
    } catch (e) { translate(e); }
  }

  async updateYear(id: string, body: UpdateAcademicYearBody, user: AuthUser) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const before = await this.getYear(id, tx);
        const start = body.startDate ?? before.startDate;
        const end = body.endDate ?? before.endDate;
        if (end <= start) throw invalid('The year must end after it starts', 'endDate');
        if (body.status === 'planned' && before.status === 'current') throw invalid('Set another year as current instead', 'status');
        await tx.updateTable('academic_years').set({
          ...(body.name && { name: body.name }), start_date: start, end_date: end,
          ...(body.status && { status: body.status }), updated_by: user.id, version: sql`version + 1`,
        }).where('id', '=', before.id).execute();
        await this.audit.record({ action: 'update', entityType: 'academic_year', entityId: before.id, changes: changes(before, body) }, user, tx);
        return this.getYear(before.id, tx);
      });
    } catch (e) { translate(e); }
  }

  /** Makes this the current year; the previous current year is closed. Picks the current term (today's term, else term 1). */
  async setCurrentYear(id: string, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const year = await this.getYear(id, tx);
      const prev = await this.currentYearId(tx);
      if (prev && prev !== year.id) {
        await tx.updateTable('academic_years').set({ status: 'closed', updated_by: user.id }).where('id', '=', prev).execute();
      }
      await tx.updateTable('academic_years').set({ status: 'current', updated_by: user.id }).where('id', '=', year.id).execute();
      await tx.updateTable('terms').set({ status: 'planned', updated_by: user.id }).where('status', '=', 'current').execute();
      const today = todayInAccra();
      const term = year.terms.find((t) => t.startDate! <= today && today <= t.endDate!) ?? year.terms[0];
      if (term) await tx.updateTable('terms').set({ status: 'current', updated_by: user.id }).where('id', '=', term.id).execute();
      await this.audit.record({ action: 'update', entityType: 'academic_year', entityId: year.id, changes: { status: { before: year.status, after: 'current' }, previousCurrentYearId: { before: prev, after: null } } }, user, tx);
      return this.getYear(year.id, tx);
    });
  }

  async updateTerm(id: string, body: UpdateTermBody, user: AuthUser) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const t = await tx.selectFrom('terms').selectAll().where('id', '=', parseId(id, 'term')).executeTakeFirst();
        if (!t) throw AppError.notFound('term');
        const y = await tx.selectFrom('academic_years').selectAll().where('id', '=', t.academic_year_id).executeTakeFirstOrThrow();
        const start = body.startDate ?? isoDate(t.start_date)!;
        const end = body.endDate ?? isoDate(t.end_date)!;
        if (end <= start) throw invalid('The term must end after it starts', 'endDate');
        if (start < isoDate(y.start_date)! || end > isoDate(y.end_date)!) throw invalid('The term must fall inside its academic year', 'startDate');
        if (body.status === 'current') await tx.updateTable('terms').set({ status: 'planned', updated_by: user.id }).where('status', '=', 'current').where('id', '<>', t.id).execute();
        await tx.updateTable('terms').set({
          ...(body.name && { name: body.name }), start_date: start, end_date: end, ...(body.status && { status: body.status }),
          updated_by: user.id, version: sql`version + 1`,
        }).where('id', '=', t.id).execute();
        await this.audit.record({ action: 'update', entityType: 'term', entityId: t.id, changes: changes({ name: t.name, startDate: isoDate(t.start_date), endDate: isoDate(t.end_date), status: t.status }, body) }, user, tx);
        return this.getYear(t.academic_year_id, tx);
      });
    } catch (e) { translate(e); }
  }

  /** The current term (or null). */
  async currentTerm(tx?: Tx): Promise<{ id: string; academicYearId: string; number: number; name: string; startDate: string; endDate: string } | null> {
    const t = await (tx ?? this.db).selectFrom('terms').selectAll().where('status', '=', 'current').executeTakeFirst();
    return t ? { id: t.id, academicYearId: t.academic_year_id, number: t.number, name: t.name, startDate: isoDate(t.start_date)!, endDate: isoDate(t.end_date)! } : null;
  }

  private yearDto(y: { id: string; name: string; start_date: Date | string; end_date: Date | string; status: string; version: number }, terms: Array<{ id: string; number: number; name: string; start_date: Date | string; end_date: Date | string; status: string }>) {
    return {
      id: y.id, name: y.name, startDate: isoDate(y.start_date)!, endDate: isoDate(y.end_date)!, status: y.status, version: y.version,
      terms: terms.map((t) => ({ id: t.id, number: t.number, name: t.name, startDate: isoDate(t.start_date), endDate: isoDate(t.end_date), status: t.status })),
    };
  }

  // ---------------- levels ----------------
  async listLevels(tx?: Tx) {
    const db = tx ?? this.db;
    const levels = await db.selectFrom('levels as l')
      .leftJoin('assessment_config as ac', 'ac.level_id', 'l.id')
      .select(['l.id', 'l.code', 'l.name', 'l.sort_order', 'l.is_final_level', 'l.next_level_id', 'l.is_active', 'l.version', 'ac.class_score_weight', 'ac.exam_score_weight'])
      .orderBy('l.sort_order').execute();
    const def = await db.selectFrom('assessment_config').select(['class_score_weight', 'exam_score_weight']).where('level_id', 'is', null).executeTakeFirst();
    return levels.map((l) => ({
      id: l.id, code: l.code, name: l.name, sortOrder: l.sort_order, isFinalLevel: l.is_final_level, nextLevelId: l.next_level_id,
      isActive: l.is_active, version: l.version,
      classScoreWeight: l.class_score_weight ?? def?.class_score_weight ?? 30,
      examScoreWeight: l.exam_score_weight ?? def?.exam_score_weight ?? 70,
    }));
  }

  private async level(id: string, tx?: Tx) {
    const all = await this.listLevels(tx);
    const l = all.find((x) => x.id === id);
    if (!l) throw AppError.notFound('level');
    return l;
  }

  async createLevel(body: CreateLevelBody, user: AuthUser) {
    this.checkLevelShape(body.isFinalLevel, body.nextLevelId ?? null, body.classScoreWeight, body.examScoreWeight);
    try {
      return await this.db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('levels').values({
          code: body.code, name: body.name, sort_order: body.sortOrder, is_final_level: body.isFinalLevel, next_level_id: body.nextLevelId ?? null,
          created_by: user.id, updated_by: user.id,
        }).returning('id').executeTakeFirstOrThrow();
        await this.saveWeights(tx, r.id, body.classScoreWeight, body.examScoreWeight, user);
        await this.audit.record({ action: 'create', entityType: 'level', entityId: r.id, changes: { code: { after: body.code } } }, user, tx);
        return this.level(r.id, tx);
      });
    } catch (e) { translate(e); }
  }

  async updateLevel(rawId: string, body: UpdateLevelBody, user: AuthUser) {
    const id = parseId(rawId, 'level');
    try {
      return await this.db.transaction().execute(async (tx) => {
        const before = await this.level(id, tx);
        const isFinal = body.isFinalLevel ?? before.isFinalLevel;
        const next = body.nextLevelId !== undefined ? body.nextLevelId : isFinal ? null : before.nextLevelId;
        this.checkLevelShape(isFinal, next, body.classScoreWeight, body.examScoreWeight);
        if (next === id) throw invalid('A level cannot move up into itself', 'nextLevelId');
        await tx.updateTable('levels').set({
          ...(body.code && { code: body.code }), ...(body.name && { name: body.name }), ...(body.sortOrder !== undefined && { sort_order: body.sortOrder }),
          is_final_level: isFinal, next_level_id: next, ...(body.isActive !== undefined && { is_active: body.isActive }),
          updated_by: user.id, version: sql`version + 1`,
        }).where('id', '=', id).execute();
        await this.saveWeights(tx, id, body.classScoreWeight, body.examScoreWeight, user);
        await this.audit.record({ action: 'update', entityType: 'level', entityId: id, changes: changes(before, body) }, user, tx);
        return this.level(id, tx);
      });
    } catch (e) { translate(e); }
  }

  private checkLevelShape(isFinal: boolean, next: string | null, cw?: number, ew?: number) {
    if (isFinal && next) throw invalid('The final level (e.g. JHS3) has no next level', 'nextLevelId');
    if ((cw === undefined) !== (ew === undefined)) throw invalid('Give both the class score and exam score weights', 'classScoreWeight');
    if (cw !== undefined && ew !== undefined && cw + ew !== 100) throw invalid('Class and exam weights must add up to 100', 'classScoreWeight');
  }

  private async saveWeights(tx: Tx, levelId: string, cw: number | undefined, ew: number | undefined, user: AuthUser) {
    if (cw === undefined || ew === undefined) return;
    await tx.insertInto('assessment_config').values({ level_id: levelId, class_score_weight: cw, exam_score_weight: ew, created_by: user.id, updated_by: user.id })
      .onConflict((oc) => oc.column('level_id').doUpdateSet({ class_score_weight: cw, exam_score_weight: ew, updated_by: user.id, version: sql`assessment_config.version + 1` }))
      .execute();
  }

  // ---------------- classes ----------------
  async listClasses(user: AuthUser, q: { academicYearId?: string; levelId?: string }) {
    const yearId = q.academicYearId ?? (await this.currentYearId());
    if (!yearId) return [];
    const allowed = await this.access.allowedClassIds(user);
    if (allowed && allowed.length === 0) return [];
    let query = this.classQuery(this.db).where('c.academic_year_id', '=', yearId).where('c.archived_at', 'is', null);
    if (q.levelId) query = query.where('c.level_id', '=', q.levelId);
    if (allowed) query = query.where('c.id', 'in', allowed);
    const rows = await query.orderBy('l.sort_order').orderBy('c.stream').execute();
    return rows.map(classDto);
  }

  async getClass(user: AuthUser, rawId: string, tx?: Tx) {
    const c = await this.access.classInScope(user, rawId, tx);
    const row = await this.classQuery(tx ?? this.db).where('c.id', '=', c.id).executeTakeFirstOrThrow();
    return classDto(row);
  }

  private classQuery(db: Db | Tx) {
    return db.selectFrom('classes as c')
      .innerJoin('levels as l', 'l.id', 'c.level_id')
      .innerJoin('academic_years as y', 'y.id', 'c.academic_year_id')
      .leftJoin('staff as s', 's.id', 'c.class_teacher_staff_id')
      .select((eb) => [
        'c.id', 'c.academic_year_id', 'y.name as academic_year_name', 'c.level_id', 'l.code as level_code', 'l.name as level_name',
        'c.stream', 'c.display_name', 'c.capacity', 'c.class_teacher_staff_id', 'c.version',
        sql<string | null>`case when s.id is null then null else concat_ws(' ', s.title, s.first_name, s.last_name) end`.as('class_teacher_name'),
        eb.selectFrom('enrolments as e').select(sql<number>`count(*)::int`.as('n')).whereRef('e.class_id', '=', 'c.id').where('e.end_date', 'is', null).as('enrolled_count'),
      ]);
  }

  async createClass(body: CreateClassBody, user: AuthUser) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const level = await this.level(body.levelId, tx).catch(() => { throw invalid('Level not found', 'levelId'); });
        const displayName = body.displayName ?? (body.stream ? `${level.name} ${body.stream}` : level.name);
        const r = await tx.insertInto('classes').values({
          academic_year_id: body.academicYearId, level_id: body.levelId, stream: body.stream ?? null, display_name: displayName,
          capacity: body.capacity ?? null, class_teacher_staff_id: body.classTeacherStaffId ?? null, created_by: user.id, updated_by: user.id,
        }).returning('id').executeTakeFirstOrThrow();
        if (body.classTeacherStaffId) await this.syncClassTeacher(tx, r.id, body.classTeacherStaffId, user);
        await this.audit.record({ action: 'create', entityType: 'class', entityId: r.id, changes: { displayName: { after: displayName } } }, user, tx);
        return this.getClass(user, r.id, tx);
      });
    } catch (e) { translate(e); }
  }

  async updateClass(user: AuthUser, rawId: string, body: UpdateClassBody) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const before = await this.getClass(user, rawId, tx);
        if (body.capacity != null && body.capacity < before.enrolledCount) {
          throw new AppError(422, ErrorCodes.CLASS_AT_CAPACITY, `${before.displayName} already has ${before.enrolledCount} students`, 'Capacity cannot be lower than the number of students in the class.');
        }
        await tx.updateTable('classes').set({
          ...(body.stream !== undefined && { stream: body.stream }), ...(body.displayName && { display_name: body.displayName }),
          ...(body.capacity !== undefined && { capacity: body.capacity }),
          ...(body.classTeacherStaffId !== undefined && { class_teacher_staff_id: body.classTeacherStaffId }),
          updated_by: user.id, version: sql`version + 1`,
        }).where('id', '=', before.id).execute();
        if (body.classTeacherStaffId !== undefined && body.classTeacherStaffId !== before.classTeacherStaffId) {
          await this.syncClassTeacher(tx, before.id, body.classTeacherStaffId, user);
        }
        await this.audit.record({ action: 'update', entityType: 'class', entityId: before.id, changes: changes(before, body) }, user, tx);
        return this.getClass(user, before.id, tx);
      });
    } catch (e) { translate(e); }
  }

  /** Keeps staff_class_assignments (which drives TEACHER scope) in step with classes.class_teacher_staff_id. */
  private async syncClassTeacher(tx: Tx, classId: string, staffId: string | null, user: AuthUser) {
    const today = todayInAccra();
    await tx.updateTable('staff_class_assignments')
      .set({ end_date: sql`greatest(start_date, ${today}::date)`, updated_by: user.id })
      .where('class_id', '=', classId).where('role', '=', 'class_teacher').where('end_date', 'is', null).execute();
    if (staffId) {
      await tx.insertInto('staff_class_assignments').values({ staff_id: staffId, class_id: classId, role: 'class_teacher', start_date: today, created_by: user.id, updated_by: user.id }).execute();
    }
  }

  // ---------------- subjects ----------------
  async listSubjects() {
    const rows = await this.db.selectFrom('subjects').selectAll().orderBy('name').execute();
    const links = await this.db.selectFrom('level_subjects').select(['level_id', 'subject_id', 'sort_order']).execute();
    return rows.map((s) => ({ id: s.id, code: s.code, name: s.name, isActive: s.is_active, version: s.version, levelIds: links.filter((l) => l.subject_id === s.id).map((l) => l.level_id) }));
  }

  async createSubject(body: { code: string; name: string; isActive: boolean }, user: AuthUser) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('subjects').values({ code: body.code, name: body.name, is_active: body.isActive, created_by: user.id, updated_by: user.id }).returningAll().executeTakeFirstOrThrow();
        await this.audit.record({ action: 'create', entityType: 'subject', entityId: r.id, changes: { code: { after: r.code } } }, user, tx);
        return { id: r.id, code: r.code, name: r.name, isActive: r.is_active, version: r.version, levelIds: [] as string[] };
      });
    } catch (e) { translate(e); }
  }

  async updateSubject(rawId: string, body: { code?: string; name?: string; isActive?: boolean }, user: AuthUser) {
    const id = parseId(rawId, 'subject');
    try {
      return await this.db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('subjects').selectAll().where('id', '=', id).executeTakeFirst();
        if (!before) throw AppError.notFound('subject');
        const r = await tx.updateTable('subjects').set({
          ...(body.code && { code: body.code }), ...(body.name && { name: body.name }), ...(body.isActive !== undefined && { is_active: body.isActive }),
          updated_by: user.id, version: sql`version + 1`,
        }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.record({ action: 'update', entityType: 'subject', entityId: id, changes: changes({ code: before.code, name: before.name, isActive: before.is_active }, body) }, user, tx);
        return { id: r.id, code: r.code, name: r.name, isActive: r.is_active, version: r.version };
      });
    } catch (e) { translate(e); }
  }

  async setLevelSubjects(rawId: string, subjectIds: string[], user: AuthUser) {
    const id = parseId(rawId, 'level');
    if (new Set(subjectIds).size !== subjectIds.length) throw invalid('A subject is listed twice', 'subjectIds');
    try {
      return await this.db.transaction().execute(async (tx) => {
        await this.level(id, tx);
        const before = await tx.selectFrom('level_subjects').select('subject_id').where('level_id', '=', id).orderBy('sort_order').execute();
        await tx.deleteFrom('level_subjects').where('level_id', '=', id).execute();
        if (subjectIds.length) {
          await tx.insertInto('level_subjects').values(subjectIds.map((s, i) => ({ level_id: id, subject_id: s, sort_order: i + 1, created_by: user.id }))).execute();
        }
        await this.audit.record({ action: 'update', entityType: 'level_subjects', entityId: id, changes: { subjectIds: { before: before.map((b) => b.subject_id), after: subjectIds } } }, user, tx);
        return this.levelSubjects(id, tx);
      });
    } catch (e) { translate(e); }
  }

  async levelSubjects(levelId: string, tx?: Tx) {
    const rows = await (tx ?? this.db).selectFrom('level_subjects as ls').innerJoin('subjects as s', 's.id', 'ls.subject_id')
      .select(['s.id', 's.code', 's.name', 'ls.sort_order']).where('ls.level_id', '=', levelId).orderBy('ls.sort_order').execute();
    return { levelId, subjects: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, sortOrder: r.sort_order })) };
  }

  // ---------------- grading scales ----------------
  async listGradingScales(tx?: Tx) {
    const db = tx ?? this.db;
    const scales = await db.selectFrom('grading_scales').selectAll().orderBy('name').execute();
    const bands = scales.length ? await db.selectFrom('grading_bands').selectAll().where('grading_scale_id', 'in', scales.map((s) => s.id)).orderBy('min_score', 'desc').execute() : [];
    return scales.map((s) => ({
      id: s.id, name: s.name, appliesToLevelIds: s.applies_to_level_ids, isDefault: s.is_default, version: s.version,
      bands: bands.filter((b) => b.grading_scale_id === s.id).map((b) => ({ minScore: b.min_score, maxScore: b.max_score, grade: b.grade, remark: b.remark })),
    }));
  }

  async saveGradingScale(rawId: string | null, body: GradingScaleBody, user: AuthUser) {
    const problem = validateBands(body.bands.map((b) => ({ ...b, remark: b.remark ?? null })));
    if (problem) throw invalid(problem, 'bands');
    try {
      return await this.db.transaction().execute(async (tx) => {
        let id: string;
        const values = { name: body.name, applies_to_level_ids: body.appliesToLevelIds, is_default: body.isDefault, updated_by: user.id };
        if (body.isDefault) await tx.updateTable('grading_scales').set({ is_default: false }).where('is_default', '=', true).execute();
        if (rawId) {
          id = parseId(rawId, 'grading scale');
          const r = await tx.updateTable('grading_scales').set({ ...values, version: sql`version + 1` }).where('id', '=', id).returning('id').executeTakeFirst();
          if (!r) throw AppError.notFound('grading scale');
          await tx.deleteFrom('grading_bands').where('grading_scale_id', '=', id).execute();
        } else {
          id = (await tx.insertInto('grading_scales').values({ ...values, created_by: user.id }).returning('id').executeTakeFirstOrThrow()).id;
        }
        const sorted = [...body.bands].sort((a, b) => b.minScore - a.minScore);
        await tx.insertInto('grading_bands').values(sorted.map((b, i) => ({
          grading_scale_id: id, min_score: b.minScore, max_score: b.maxScore, grade: b.grade, remark: b.remark ?? null, sort_order: i + 1, created_by: user.id, updated_by: user.id,
        }))).execute();
        await this.audit.record({ action: rawId ? 'update' : 'create', entityType: 'grading_scale', entityId: id, changes: { bands: { after: sorted } } }, user, tx);
        return (await this.listGradingScales(tx)).find((s) => s.id === id)!;
      });
    } catch (e) { translate(e); }
  }
}

type ClassRow = {
  id: string; academic_year_id: string; academic_year_name: string; level_id: string; level_code: string; level_name: string;
  stream: string | null; display_name: string; capacity: number | null; class_teacher_staff_id: string | null; class_teacher_name: string | null;
  version: number; enrolled_count: number | null;
};
function classDto(r: ClassRow) {
  const enrolled = r.enrolled_count ?? 0;
  return {
    id: r.id, academicYearId: r.academic_year_id, academicYear: r.academic_year_name, levelId: r.level_id, levelCode: r.level_code, levelName: r.level_name,
    stream: r.stream, displayName: r.display_name, capacity: r.capacity, enrolledCount: enrolled,
    availablePlaces: r.capacity === null ? null : Math.max(0, r.capacity - enrolled),
    classTeacherStaffId: r.class_teacher_staff_id, classTeacherName: r.class_teacher_name, version: r.version,
  };
}
