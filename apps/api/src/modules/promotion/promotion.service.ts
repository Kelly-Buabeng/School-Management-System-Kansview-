// Owner: Agent B. Year-end promotion: draft preview, per-student exceptions, arrears policy, one-transaction commit, undo.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { LEDGER_SERVICE, type LedgerService } from '../../common/contracts';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { IDEMPOTENCY_SERVICE, type IdempotencyService } from '../../security/idempotency';
import { isUniqueViolation, isoInstant } from '../settings/common/db';
import { parseId, zUuid } from '../settings/common/http';
import { SettingsService } from '../settings/settings.service';
import { AcademicSetupService } from '../academic-setup/academic-setup.service';
import { StudentReader } from '../students/student-reader';
import {
  actionNeedsTarget, arrearsFlag, canUndoNow, checkCommit, closedEnrolmentStatus, defaultPlacement, statusAfter, undoDeadline,
  type ArrearsPolicy, type ClassInfo, type LevelInfo, type PromotionAction,
} from './promotion-rules';

export const CreateRunBody = z.strictObject({
  fromAcademicYearId: zUuid.optional(),
  toAcademicYearId: zUuid,
  classIds: z.array(zUuid).min(1).max(100),
});
export const UpdateItemBody = z.strictObject({
  action: z.enum(['promote', 'repeat', 'skip', 'withdraw', 'transfer_out', 'graduate']).optional(),
  targetClassId: zUuid.nullable().optional(),
  overrideReason: z.string().trim().max(300).nullable().optional(),
});
export const UndoBody = z.strictObject({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) });

const invalidState = (msg: string) => new AppError(422, ErrorCodes.PROMOTION_INVALID_STATE, msg);

@Injectable()
export class PromotionService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(LEDGER_SERVICE) private readonly ledger: LedgerService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idem: IdempotencyService,
    private readonly settings: SettingsService,
    private readonly setup: AcademicSetupService,
    private readonly reader: StudentReader,
  ) {}

  async list() {
    const rows = await this.db.selectFrom('promotion_runs as r').innerJoin('academic_years as f', 'f.id', 'r.from_academic_year_id').innerJoin('academic_years as t', 't.id', 'r.to_academic_year_id')
      .select((eb) => ['r.id', 'r.status', 'r.from_academic_year_id', 'r.to_academic_year_id', 'f.name as from_name', 't.name as to_name', 'r.scope', 'r.committed_at', 'r.undo_deadline', 'r.undone_at', 'r.created_at', 'r.arrears_policy_snapshot',
        eb.selectFrom('promotion_run_items as i').select(sql<number>`count(*)::int`.as('n')).whereRef('i.run_id', '=', 'r.id').as('item_count')])
      .orderBy('r.created_at', 'desc').execute();
    return rows.map((r) => ({
      id: r.id, status: r.status, fromAcademicYearId: r.from_academic_year_id, fromAcademicYear: r.from_name, toAcademicYearId: r.to_academic_year_id, toAcademicYear: r.to_name,
      classIds: r.scope, itemCount: r.item_count ?? 0, arrearsPolicy: r.arrears_policy_snapshot, committedAt: isoInstant(r.committed_at), undoDeadline: isoInstant(r.undo_deadline), undoneAt: isoInstant(r.undone_at), createdAt: isoInstant(r.created_at),
    }));
  }

  async get(rawId: string, tx?: Tx) {
    const db = tx ?? this.db;
    const r = await db.selectFrom('promotion_runs').selectAll().where('id', '=', parseId(rawId, 'promotion run')).executeTakeFirst();
    if (!r) throw AppError.notFound('promotion run');
    const items = await db.selectFrom('promotion_run_items as i').innerJoin('students as s', 's.id', 'i.student_id')
      .leftJoin('enrolments as fe', 'fe.id', 'i.from_enrolment_id')
      .leftJoin('classes as fc', 'fc.id', 'fe.class_id')
      .leftJoin('classes as tc', 'tc.id', 'i.target_class_id')
      .select(['i.id', 'i.student_id', 'i.action', 'i.target_class_id', 'tc.display_name as target_class_name', 'fc.id as from_class_id', 'fc.display_name as from_class_name',
        'i.outstanding_pesewas_snapshot', 'i.arrears_flag', 'i.override_reason', 'i.created_enrolment_id', 'i.previous_status'])
      .where('i.run_id', '=', r.id)
      .orderBy('fc.display_name').orderBy('s.last_name').orderBy('s.first_name').execute();
    const summaries = await this.reader.summaries(items.map((i) => i.student_id), tx);
    const policy = (r.arrears_policy_snapshot ?? 'warn') as ArrearsPolicy;
    return {
      id: r.id, status: r.status, fromAcademicYearId: r.from_academic_year_id, toAcademicYearId: r.to_academic_year_id, classIds: r.scope,
      arrearsPolicy: policy, committedAt: isoInstant(r.committed_at), undoDeadline: isoInstant(r.undo_deadline), undoneAt: isoInstant(r.undone_at), version: r.version,
      counts: countBy(items.map((i) => i.action)),
      items: items.map((i) => ({
        id: i.id, student: summaries.get(i.student_id) ?? null, studentId: i.student_id, fromClassId: i.from_class_id, fromClassName: i.from_class_name,
        action: i.action, targetClassId: i.target_class_id, targetClassName: i.target_class_name, outstandingPesewas: i.outstanding_pesewas_snapshot ?? 0,
        arrearsFlag: i.arrears_flag, blocked: policy === 'block' && i.arrears_flag && (i.action === 'promote' || i.action === 'skip') && !i.override_reason,
        overrideReason: i.override_reason,
      })),
    };
  }

  /** Builds a draft for the chosen classes: default target = next level's class (same stream) in the target year; final level graduates. */
  async create(body: z.infer<typeof CreateRunBody>, user: AuthUser) {
    const fromYearId = body.fromAcademicYearId ?? (await this.setup.currentYearId());
    if (!fromYearId) throw new AppError(422, ErrorCodes.PROMOTION_INVALID_STATE, 'Set the current academic year first');
    if (fromYearId === body.toAcademicYearId) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a different year to promote into');
    const toYear = await this.db.selectFrom('academic_years').select(['id', 'status']).where('id', '=', body.toAcademicYearId).executeTakeFirst();
    if (!toYear) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'The target academic year was not found');
    const classes = await this.db.selectFrom('classes').select(['id', 'level_id', 'stream', 'academic_year_id']).where('id', 'in', body.classIds).execute();
    if (classes.length !== new Set(body.classIds).size || classes.some((c) => c.academic_year_id !== fromYearId)) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Every class must belong to the year you are promoting from');
    }
    const levels = new Map<string, LevelInfo>((await this.db.selectFrom('levels').select(['id', 'next_level_id', 'is_final_level']).execute()).map((l) => [l.id, { id: l.id, nextLevelId: l.next_level_id, isFinalLevel: l.is_final_level }]));
    const targetClasses: ClassInfo[] = (await this.db.selectFrom('classes').select(['id', 'level_id', 'stream', 'academic_year_id']).where('academic_year_id', '=', body.toAcademicYearId).where('archived_at', 'is', null).execute())
      .map((c) => ({ id: c.id, levelId: c.level_id, stream: c.stream, academicYearId: c.academic_year_id }));
    const enrolments = await this.db.selectFrom('enrolments as e').innerJoin('students as s', 's.id', 'e.student_id')
      .select(['e.id', 'e.student_id', 'e.class_id']).where('e.class_id', 'in', body.classIds).where('e.end_date', 'is', null)
      .where('s.status', '=', 'active').where('s.archived_at', 'is', null).execute();
    const policy = await this.settings.getPolicy('promotion.block_on_arrears');
    const outstanding = enrolments.length ? await this.ledger.outstandingByStudent(enrolments.map((e) => e.student_id)) : new Map<string, number>();

    const id = await this.db.transaction().execute(async (tx) => {
      const run = await tx.insertInto('promotion_runs').values({
        from_academic_year_id: fromYearId, to_academic_year_id: body.toAcademicYearId, scope: body.classIds, status: 'draft', arrears_policy_snapshot: policy,
        created_by: user.id, updated_by: user.id,
      }).returning('id').executeTakeFirstOrThrow();
      if (enrolments.length) {
        await tx.insertInto('promotion_run_items').values(enrolments.map((e) => {
          const c = classes.find((x) => x.id === e.class_id)!;
          const placement = defaultPlacement({ id: c.id, levelId: c.level_id, stream: c.stream, academicYearId: c.academic_year_id }, levels, targetClasses);
          const owed = outstanding.get(e.student_id) ?? 0;
          return {
            run_id: run.id, student_id: e.student_id, from_enrolment_id: e.id,
            // promote/repeat need a target (DB check): without a class in the target year the item starts as 'skip' with no target.
            action: placement.action === 'promote' && !placement.targetClassId ? 'skip' as const : placement.action,
            target_class_id: placement.targetClassId, outstanding_pesewas_snapshot: owed, arrears_flag: arrearsFlag(owed, policy),
            created_by: user.id, updated_by: user.id,
          };
        })).execute();
      }
      await this.audit.record({ action: 'create', entityType: 'promotion_run', entityId: run.id, changes: { classIds: { after: body.classIds }, students: { after: enrolments.length } } }, user, tx);
      return run.id;
    });
    return this.get(id);
  }

  async updateItem(rawRunId: string, rawItemId: string, body: z.infer<typeof UpdateItemBody>, user: AuthUser) {
    const runId = parseId(rawRunId, 'promotion run');
    const itemId = parseId(rawItemId, 'promotion item');
    await this.db.transaction().execute(async (tx) => {
      const run = await tx.selectFrom('promotion_runs').select(['status', 'to_academic_year_id']).where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!run) throw AppError.notFound('promotion run');
      if (run.status !== 'draft') throw invalidState('This promotion run is no longer a draft');
      const item = await tx.selectFrom('promotion_run_items').selectAll().where('id', '=', itemId).where('run_id', '=', runId).executeTakeFirst();
      if (!item) throw AppError.notFound('promotion item');
      const action = (body.action ?? item.action) as PromotionAction;
      let target = body.targetClassId !== undefined ? body.targetClassId : item.target_class_id;
      if (!actionNeedsTarget(action)) target = null;
      if (actionNeedsTarget(action)) {
        if (!target) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a class for next year', undefined, [{ field: 'targetClassId', code: 'REQUIRED', message: 'Choose a class' }]);
        const c = await tx.selectFrom('classes').select('academic_year_id').where('id', '=', target).executeTakeFirst();
        if (!c || c.academic_year_id !== run.to_academic_year_id) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a class in the year you are promoting into');
      }
      await tx.updateTable('promotion_run_items').set({
        action, target_class_id: target, ...(body.overrideReason !== undefined && { override_reason: body.overrideReason || null }), updated_by: user.id,
      }).where('id', '=', itemId).execute();
      await tx.updateTable('promotion_runs').set({ updated_by: user.id }).where('id', '=', runId).execute();
    });
    return this.get(runId);
  }

  async commit(rawId: string, idempotencyKey: string | undefined, user: AuthUser) {
    const runId = parseId(rawId, 'promotion run');
    const res = await this.idem.run(idempotencyKey, `POST /promotion-runs/${runId}/commit`, { runId }, user, async () => {
      await this.db.transaction().execute((tx) => this.commitInTx(tx, runId, user));
      return { status: 200, body: await this.get(runId) };
    });
    return res.body;
  }

  private async commitInTx(tx: Tx, runId: string, user: AuthUser) {
    const run = await tx.selectFrom('promotion_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
    if (!run) throw AppError.notFound('promotion run');
    if (run.status === 'committed') return; // replay: already applied, nothing to do
    if (run.status !== 'draft') throw invalidState('This promotion run was undone. Start a new run.');
    const items = await tx.selectFrom('promotion_run_items as i').innerJoin('students as s', 's.id', 'i.student_id')
      .leftJoin('enrolments as e', 'e.id', 'i.from_enrolment_id')
      .select(['i.id', 'i.student_id', 'i.action', 'i.target_class_id', 'i.arrears_flag', 'i.override_reason', 'i.from_enrolment_id', 's.status', 's.first_name', 's.last_name', 'e.end_date', 'e.start_date'])
      .where('i.run_id', '=', runId).orderBy('s.last_name').orderBy('s.first_name').execute();
    const stale = items.filter((i) => i.end_date !== null || i.status !== 'active');
    if (stale.length) throw invalidState(`${stale.length} student(s) changed class or status after this draft was made. Start a new run.`);

    const policy = (run.arrears_policy_snapshot ?? 'warn') as ArrearsPolicy;
    const targetIds = [...new Set(items.map((i) => i.target_class_id).filter((x): x is string => !!x))];
    const cap = new Map<string, { name: string; capacity: number | null; existing: number }>();
    if (targetIds.length) {
      const rows = await tx.selectFrom('classes as c').select((eb) => ['c.id', 'c.display_name', 'c.capacity',
        eb.selectFrom('enrolments as e').select(sql<number>`count(*)::int`.as('n')).whereRef('e.class_id', '=', 'c.id').where('e.end_date', 'is', null).as('n')])
        .where('c.id', 'in', targetIds).forUpdate().execute();
      for (const r of rows) cap.set(r.id, { name: r.display_name, capacity: r.capacity, existing: r.n ?? 0 });
    }
    const problems = checkCommit(items.map((i) => ({ id: i.id, studentName: `${i.first_name} ${i.last_name}`, action: i.action, targetClassId: i.target_class_id, arrearsFlag: i.arrears_flag, overrideReason: i.override_reason })), policy, cap);
    if (problems.length) {
      const blocked = problems.some((p) => p.code === 'ARREARS_OVERRIDE_REQUIRED');
      throw new AppError(422, blocked ? ErrorCodes.PROMOTION_BLOCKED_ARREARS : ErrorCodes.PROMOTION_INVALID_STATE,
        blocked ? 'Some students have unpaid fees and need a reason to be promoted' : 'Some students cannot be promoted yet',
        problems.slice(0, 5).map((p) => p.message).join('; '), problems.map((p) => ({ field: `items.${p.itemId}`, code: p.code, message: p.message })), { problems });
    }

    const toYear = await tx.selectFrom('academic_years').select(['start_date']).where('id', '=', run.to_academic_year_id).executeTakeFirstOrThrow();
    const fromYear = await tx.selectFrom('academic_years').select(['end_date']).where('id', '=', run.from_academic_year_id).executeTakeFirstOrThrow();
    const today = todayInAccra();
    const closeOn = today < fromYear.end_date ? today : fromYear.end_date;
    const nextRoll = new Map<string, number>();
    for (const id of targetIds) {
      const m = await tx.selectFrom('enrolments').select(sql<number>`coalesce(max(roll_number), 0)::int`.as('m')).where('class_id', '=', id).where('end_date', 'is', null).executeTakeFirstOrThrow();
      nextRoll.set(id, m.m);
    }
    for (const i of items) {
      const end = closeOn < i.start_date! ? i.start_date! : closeOn;
      await tx.updateTable('enrolments').set({ end_date: end, status: closedEnrolmentStatus(i.action), updated_by: user.id }).where('id', '=', i.from_enrolment_id!).execute();
      let createdId: string | null = null;
      if (actionNeedsTarget(i.action)) {
        const roll = (nextRoll.get(i.target_class_id!) ?? 0) + 1;
        nextRoll.set(i.target_class_id!, roll);
        createdId = (await tx.insertInto('enrolments').values({
          student_id: i.student_id, class_id: i.target_class_id!, academic_year_id: run.to_academic_year_id, roll_number: roll, start_date: toYear.start_date,
          status: 'active', reason: i.action === 'repeat' ? 'Repeating the year' : 'Promoted', promotion_run_id: runId, created_by: user.id, updated_by: user.id,
        }).returning('id').executeTakeFirstOrThrow()).id;
      }
      const newStatus = statusAfter(i.action);
      if (newStatus) {
        const db = newStatus === 'alumni' ? 'graduated' : newStatus;
        await tx.updateTable('students').set({ status: db, updated_by: user.id }).where('id', '=', i.student_id).execute();
        await tx.insertInto('student_status_history').values({ student_id: i.student_id, from_status: 'active', to_status: db, effective_date: end, reason: `Promotion run: ${i.action}`, source: 'promotion', source_ref_id: runId, created_by: user.id }).execute();
      }
      await tx.updateTable('promotion_run_items').set({ created_enrolment_id: createdId, previous_status: 'active', updated_by: user.id }).where('id', '=', i.id).execute();
    }
    const windowDays = await this.settings.getPolicy('promotion.undo_window_days', tx);
    const now = new Date();
    await tx.updateTable('promotion_runs').set({ status: 'committed', committed_at: now, committed_by: user.id, undo_deadline: undoDeadline(now, windowDays), updated_by: user.id }).where('id', '=', runId).execute();
    const overrides = items.filter((i) => i.arrears_flag && i.override_reason).map((i) => ({ studentId: i.student_id, reason: i.override_reason }));
    await this.audit.record({ action: 'update', entityType: 'promotion_run', entityId: runId, changes: { status: { before: 'draft', after: 'committed' }, counts: { after: countBy(items.map((i) => i.action)) }, arrearsOverrides: { after: overrides } } }, user, tx);
  }

  /** Restores exactly the state before commit, only inside the undo window and when nothing depends on the new enrolments. */
  async undo(rawId: string, reason: string, user: AuthUser) {
    const runId = parseId(rawId, 'promotion run');
    await this.db.transaction().execute(async (tx) => {
      const run = await tx.selectFrom('promotion_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!run) throw AppError.notFound('promotion run');
      if (run.status !== 'committed') throw invalidState('Only a committed promotion run can be undone');
      if (!canUndoNow(run.undo_deadline)) {
        throw new AppError(422, ErrorCodes.PROMOTION_UNDO_WINDOW_CLOSED, 'The time to undo this promotion has passed', `It could be undone until ${isoInstant(run.undo_deadline)}. Correct individual students with a class change instead.`);
      }
      const items = await tx.selectFrom('promotion_run_items as i').innerJoin('students as s', 's.id', 'i.student_id')
        .select(['i.id', 'i.student_id', 'i.action', 'i.from_enrolment_id', 'i.created_enrolment_id', 'i.previous_status', 's.status', 's.first_name', 's.last_name'])
        .where('i.run_id', '=', runId).execute();
      const problems = await this.undoDependents(tx, run, items);
      if (problems.length) {
        throw new AppError(422, ErrorCodes.PROMOTION_UNDO_HAS_DEPENDENTS, 'This promotion cannot be undone because later records depend on it',
          problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` and ${problems.length - 5} more` : ''), undefined, { problems });
      }
      const created = items.map((i) => i.created_enrolment_id).filter((x): x is string => !!x);
      if (created.length) {
        await tx.updateTable('promotion_run_items').set({ created_enrolment_id: null }).where('run_id', '=', runId).execute();
        await tx.deleteFrom('enrolments').where('id', 'in', created).execute();
      }
      try {
        for (const i of items) {
          await tx.updateTable('enrolments').set({ end_date: null, status: 'active', updated_by: user.id }).where('id', '=', i.from_enrolment_id!).execute();
          const prev = i.previous_status ?? 'active';
          if (i.status !== prev) {
            await tx.updateTable('students').set({ status: prev, updated_by: user.id }).where('id', '=', i.student_id).execute();
            await tx.insertInto('student_status_history').values({ student_id: i.student_id, from_status: i.status, to_status: prev, reason: `Promotion undone: ${reason}`, source: 'promotion', source_ref_id: runId, created_by: user.id }).execute();
          }
        }
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(422, ErrorCodes.PROMOTION_UNDO_HAS_DEPENDENTS, 'This promotion cannot be undone: a roll number or class place has been reused since');
        throw e;
      }
      await tx.updateTable('promotion_runs').set({ status: 'undone', undone_at: sql`now()`, undone_by: user.id, updated_by: user.id }).where('id', '=', runId).execute();
      await this.audit.record({ action: 'update', entityType: 'promotion_run', entityId: runId, changes: { status: { before: 'committed', after: 'undone' }, students: { after: items.length } }, reason }, user, tx);
    });
    return this.get(runId);
  }

  private async undoDependents(tx: Tx, run: { id: string; to_academic_year_id: string; committed_at: Date | null }, items: Array<{ student_id: string; created_enrolment_id: string | null; first_name: string; last_name: string }>): Promise<string[]> {
    if (!items.length) return [];
    const problems: string[] = [];
    const ids = items.map((i) => i.student_id);
    const name = (sid: string) => { const i = items.find((x) => x.student_id === sid)!; return `${i.first_name} ${i.last_name}`; };
    // Enrolment changes after commit (other than the rows this run created, still open).
    const later = await tx.selectFrom('enrolments').select(['student_id', 'id', 'end_date', 'promotion_run_id']).where('student_id', 'in', ids)
      .where((eb) => eb.or([eb('created_at', '>', run.committed_at!), eb('promotion_run_id', '=', run.id)])).execute();
    for (const e of later) {
      const mine = items.find((i) => i.created_enrolment_id === e.id);
      if (!mine || e.end_date !== null) problems.push(`${name(e.student_id)} changed class after the promotion`);
    }
    // Status changes after commit not made by this run.
    const statusChanges = await tx.selectFrom('student_status_history').select('student_id').where('student_id', 'in', ids).where('created_at', '>', run.committed_at!)
      .where((eb) => eb.or([eb('source_ref_id', 'is', null), eb('source_ref_id', '<>', run.id)])).execute();
    for (const s of statusChanges) problems.push(`${name(s.student_id)} had a status change after the promotion`);
    // Invoices issued in the new year.
    const invoices = await tx.selectFrom('invoices as inv').innerJoin('terms as t', 't.id', 'inv.term_id').select(['inv.student_id', 'inv.invoice_no'])
      .where('inv.student_id', 'in', ids).where('t.academic_year_id', '=', run.to_academic_year_id).where('inv.status', '=', 'issued').execute();
    for (const i of invoices) problems.push(`${name(i.student_id)} already has invoice ${i.invoice_no} for the new year (void it first)`);
    // Attendance or scores recorded in the new year's classes.
    const created = items.map((i) => i.created_enrolment_id).filter((x): x is string => !!x);
    if (created.length) {
      const att = await tx.selectFrom('attendance_records as ar').innerJoin('attendance_sessions as s', 's.id', 'ar.session_id').innerJoin('classes as c', 'c.id', 's.class_id')
        .select('ar.student_id').distinct().where('ar.student_id', 'in', ids).where('c.academic_year_id', '=', run.to_academic_year_id).execute();
      for (const a of att) problems.push(`${name(a.student_id)} has attendance recorded in the new year`);
      const sc = await tx.selectFrom('term_scores as ts').innerJoin('terms as t', 't.id', 'ts.term_id').select('ts.student_id').distinct()
        .where('ts.student_id', 'in', ids).where('t.academic_year_id', '=', run.to_academic_year_id).execute();
      for (const s of sc) problems.push(`${name(s.student_id)} has scores entered in the new year`);
    }
    return [...new Set(problems)];
  }
}

function countBy(actions: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of actions) out[a] = (out[a] ?? 0) + 1;
  return out;
}
