import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sms/shared';
import type { z } from 'zod';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { SCOPE_SERVICE, type ScopeService } from '../../security/scope.service';
import { assertEditable, assertTransition, validateLines, type FeeStructureStatus } from './domain';
import type { CreateFeeItemBody, CreateFeeStructureBody, ReplaceFeeStructureLinesBody, SetOptionalItemsBody, UpdateFeeItemBody } from './dto';
import { assertStudentInScope, isUniqueViolation } from './support';

type LineInput = { feeItemId: string; amountPesewas: number; isOptional?: boolean };

@Injectable()
export class FeeStructuresService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
  ) {}

  // ---------------- fee items ----------------
  async listFeeItems() {
    const rows = await this.db.selectFrom('fee_items').selectAll().orderBy('allocation_priority').orderBy('code').execute();
    return { data: rows.map(feeItemView) };
  }

  async createFeeItem(body: z.infer<typeof CreateFeeItemBody>, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      try {
        const row = await tx.insertInto('fee_items').values({
          code: body.code, name: body.name, category: body.category, is_optional: body.isOptional,
          allocation_priority: body.allocationPriority, created_by: user.id, updated_by: user.id,
        }).returningAll().executeTakeFirstOrThrow();
        await this.audit.record({ action: 'create', entityType: 'fee_item', entityId: row.id, changes: { code: { after: row.code }, name: { after: row.name } } }, user, tx);
        return feeItemView(row);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'This fee item code is already used', undefined, [{ field: 'code', code: 'DUPLICATE', message: 'Choose another code' }]);
        throw e;
      }
    });
  }

  async updateFeeItem(id: string, body: z.infer<typeof UpdateFeeItemBody>, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('fee_items').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('fee item');
      const row = await tx.updateTable('fee_items').set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.category !== undefined && { category: body.category }),
        ...(body.isOptional !== undefined && { is_optional: body.isOptional }),
        ...(body.isActive !== undefined && { is_active: body.isActive }),
        ...(body.allocationPriority !== undefined && { allocation_priority: body.allocationPriority }),
        updated_by: user.id,
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const k of ['name', 'category', 'is_optional', 'is_active', 'allocation_priority'] as const) {
        if (before[k] !== row[k]) changes[k] = { before: before[k], after: row[k] };
      }
      await this.audit.record({ action: 'update', entityType: 'fee_item', entityId: id, changes }, user, tx);
      return feeItemView(row);
    });
  }

  // ---------------- fee structures ----------------
  async list(termId?: string) {
    let q = this.db.selectFrom('fee_structures as fs')
      .innerJoin('terms as t', 't.id', 'fs.term_id')
      .innerJoin('levels as l', 'l.id', 'fs.level_id')
      .leftJoin('classes as c', 'c.id', 'fs.class_id')
      .select(['fs.id', 'fs.name', 'fs.status', 'fs.term_id', 'fs.level_id', 'fs.class_id', 'fs.academic_year_id', 'fs.activated_at', 'fs.retired_at', 't.name as term_name', 'l.name as level_name', 'c.display_name as class_name'])
      .orderBy('l.sort_order').orderBy('fs.created_at');
    if (termId) q = q.where('fs.term_id', '=', termId);
    const rows = await q.execute();
    const totals = rows.length === 0 ? [] : await this.db.selectFrom('fee_structure_lines').select(['fee_structure_id', (eb) => eb.fn.sum<string>('amount_pesewas').as('total')])
      .where('fee_structure_id', 'in', rows.map((r) => r.id)).groupBy('fee_structure_id').execute();
    const t = new Map(totals.map((x) => [x.fee_structure_id, Number(x.total)]));
    return {
      data: rows.map((r) => ({
        id: r.id, name: r.name, status: r.status, termId: r.term_id, termName: r.term_name, levelId: r.level_id, levelName: r.level_name,
        classId: r.class_id, className: r.class_name, academicYearId: r.academic_year_id,
        activatedAt: r.activated_at, retiredAt: r.retired_at, totalPesewas: t.get(r.id) ?? 0,
      })),
    };
  }

  async get(id: string, db: Db | Tx = this.db) {
    const s = await db.selectFrom('fee_structures').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw AppError.notFound('fee structure');
    const lines = await db.selectFrom('fee_structure_lines as fl').innerJoin('fee_items as fi', 'fi.id', 'fl.fee_item_id')
      .select(['fl.id', 'fl.fee_item_id', 'fl.amount_pesewas', 'fl.is_optional', 'fi.name', 'fi.code', 'fi.category', 'fi.allocation_priority'])
      .where('fl.fee_structure_id', '=', id).orderBy('fi.allocation_priority').orderBy('fi.code').execute();
    const mapped = lines.map((l) => ({
      id: l.id, feeItemId: l.fee_item_id, feeItemCode: l.code, feeItemName: l.name, category: l.category,
      amountPesewas: Number(l.amount_pesewas), isOptional: l.is_optional, allocationPriority: l.allocation_priority,
    }));
    return {
      id: s.id, name: s.name, status: s.status, termId: s.term_id, levelId: s.level_id, classId: s.class_id, academicYearId: s.academic_year_id,
      activatedAt: s.activated_at, activatedBy: s.activated_by, retiredAt: s.retired_at, version: s.version,
      lines: mapped,
      compulsoryTotalPesewas: mapped.filter((l) => !l.isOptional).reduce((a, l) => a + l.amountPesewas, 0),
      totalPesewas: mapped.reduce((a, l) => a + l.amountPesewas, 0),
    };
  }

  async create(body: z.infer<typeof CreateFeeStructureBody>, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const term = await tx.selectFrom('terms').select(['id', 'academic_year_id']).where('id', '=', body.termId).executeTakeFirst();
      if (!term) throw fieldError('termId', 'Term not found');
      const level = await tx.selectFrom('levels').select('id').where('id', '=', body.levelId).executeTakeFirst();
      if (!level) throw fieldError('levelId', 'Level not found');
      if (body.classId) {
        const cls = await tx.selectFrom('classes').select(['level_id', 'academic_year_id']).where('id', '=', body.classId).executeTakeFirst();
        if (!cls || cls.level_id !== body.levelId || cls.academic_year_id !== term.academic_year_id) throw fieldError('classId', 'Class is not in this level and year');
      }
      let lines: LineInput[] = body.lines ?? [];
      if (body.copyFromStructureId) {
        const src = await tx.selectFrom('fee_structure_lines').select(['fee_item_id', 'amount_pesewas', 'is_optional']).where('fee_structure_id', '=', body.copyFromStructureId).execute();
        if (src.length === 0 && !(await tx.selectFrom('fee_structures').select('id').where('id', '=', body.copyFromStructureId).executeTakeFirst())) {
          throw fieldError('copyFromStructureId', 'Fee structure to copy was not found');
        }
        if (!body.lines) lines = src.map((l) => ({ feeItemId: l.fee_item_id, amountPesewas: Number(l.amount_pesewas), isOptional: l.is_optional }));
      }
      const s = await tx.insertInto('fee_structures').values({
        academic_year_id: term.academic_year_id, term_id: body.termId, level_id: body.levelId, class_id: body.classId ?? null,
        name: body.name, status: 'draft', created_by: user.id, updated_by: user.id,
      }).returning('id').executeTakeFirstOrThrow();
      await this.writeLines(tx, s.id, lines, user);
      await this.audit.record({ action: 'create', entityType: 'fee_structure', entityId: s.id, changes: { name: { after: body.name }, copiedFrom: { after: body.copyFromStructureId ?? null } } }, user, tx);
      return this.get(s.id, tx);
    });
  }

  async replaceLines(id: string, body: z.infer<typeof ReplaceFeeStructureLinesBody>, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom('fee_structures').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!s) throw AppError.notFound('fee structure');
      assertEditable(s.status as FeeStructureStatus);
      const before = await this.get(id, tx);
      if (body.name) await tx.updateTable('fee_structures').set({ name: body.name, updated_by: user.id }).where('id', '=', id).execute();
      await tx.deleteFrom('fee_structure_lines').where('fee_structure_id', '=', id).execute();
      await this.writeLines(tx, id, body.lines, user);
      const after = await this.get(id, tx);
      await this.audit.record({ action: 'update', entityType: 'fee_structure', entityId: id, changes: { lines: { before: before.lines.map(lineSummary), after: after.lines.map(lineSummary) } } }, user, tx);
      return after;
    });
  }

  /** draft → active. A previously active structure for the same term/level/class is retired in the same transaction. */
  async activate(id: string, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom('fee_structures').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!s) throw AppError.notFound('fee structure');
      assertTransition(s.status as FeeStructureStatus, 'active');
      const lines = await tx.selectFrom('fee_structure_lines').select('amount_pesewas').where('fee_structure_id', '=', id).execute();
      if (!lines.some((l) => Number(l.amount_pesewas) > 0)) {
        throw new AppError(422, ErrorCodes.FEE_STRUCTURE_NOT_ACTIVE, 'This fee structure has no amounts', 'Add at least one fee with an amount before activating.');
      }
      let prev = tx.selectFrom('fee_structures').select('id').where('term_id', '=', s.term_id).where('level_id', '=', s.level_id).where('status', '=', 'active');
      prev = s.class_id ? prev.where('class_id', '=', s.class_id) : prev.where('class_id', 'is', null);
      const old = await prev.execute();
      for (const o of old) {
        await tx.updateTable('fee_structures').set({ status: 'retired', retired_at: new Date(), retired_by: user.id, updated_by: user.id }).where('id', '=', o.id).execute();
        await this.audit.record({ action: 'update', entityType: 'fee_structure', entityId: o.id, changes: { status: { before: 'active', after: 'retired' } }, reason: `Replaced by ${id}` }, user, tx);
      }
      await tx.updateTable('fee_structures').set({ status: 'active', activated_at: new Date(), activated_by: user.id, updated_by: user.id }).where('id', '=', id).execute();
      await this.audit.record({ action: 'approve', entityType: 'fee_structure', entityId: id, changes: { status: { before: 'draft', after: 'active' } } }, user, tx);
      return { ...(await this.get(id, tx)), retiredStructureIds: old.map((o) => o.id) };
    });
  }

  private async writeLines(tx: Tx, structureId: string, lines: LineInput[], user: AuthUser): Promise<void> {
    validateLines(lines);
    if (lines.length === 0) return;
    const items = await tx.selectFrom('fee_items').select(['id', 'is_optional', 'is_active']).where('id', 'in', lines.map((l) => l.feeItemId)).execute();
    const byId = new Map(items.map((i) => [i.id, i]));
    lines.forEach((l, i) => {
      const it = byId.get(l.feeItemId);
      if (!it) throw fieldError(`lines.${i}.feeItemId`, 'Fee item not found');
      if (!it.is_active) throw fieldError(`lines.${i}.feeItemId`, 'Fee item is not active');
    });
    await tx.insertInto('fee_structure_lines').values(lines.map((l) => ({
      fee_structure_id: structureId, fee_item_id: l.feeItemId, amount_pesewas: l.amountPesewas,
      is_optional: l.isOptional ?? byId.get(l.feeItemId)!.is_optional, created_by: user.id, updated_by: user.id,
    }))).execute();
  }

  // ---------------- optional items ----------------
  async setOptionalItems(studentId: string, body: z.infer<typeof SetOptionalItemsBody>, user: AuthUser) {
    await assertStudentInScope(this.scope, user, studentId);
    return this.db.transaction().execute(async (tx) => {
      const st = await tx.selectFrom('students').select('id').where('id', '=', studentId).executeTakeFirst();
      if (!st) throw AppError.notFound('student');
      const term = await tx.selectFrom('terms').select('id').where('id', '=', body.termId).executeTakeFirst();
      if (!term) throw fieldError('termId', 'Term not found');
      if (body.items.length) {
        const items = await tx.selectFrom('fee_items').select(['id', 'is_optional']).where('id', 'in', body.items.map((i) => i.feeItemId)).execute();
        body.items.forEach((it, i) => {
          if (!items.find((x) => x.id === it.feeItemId)) throw fieldError(`items.${i}.feeItemId`, 'Fee item not found');
        });
        await tx.insertInto('student_optional_items').values(body.items.map((it) => ({
          student_id: studentId, term_id: body.termId, fee_item_id: it.feeItemId, opted_in: it.optedIn, created_by: user.id, updated_by: user.id,
        }))).onConflict((oc) => oc.constraint('student_optional_items_key').doUpdateSet((eb) => ({ opted_in: eb.ref('excluded.opted_in'), updated_by: user.id }))).execute();
      }
      await this.audit.record({ action: 'update', entityType: 'student_optional_items', entityId: studentId, studentId, changes: { items: { after: body.items } } }, user, tx);
      const rows = await tx.selectFrom('student_optional_items').select(['fee_item_id', 'opted_in']).where('student_id', '=', studentId).where('term_id', '=', body.termId).execute();
      return { studentId, termId: body.termId, items: rows.map((r) => ({ feeItemId: r.fee_item_id, optedIn: r.opted_in })) };
    });
  }
}

function lineSummary(l: { feeItemId: string; amountPesewas: number; isOptional: boolean }) {
  return { feeItemId: l.feeItemId, amountPesewas: l.amountPesewas, isOptional: l.isOptional };
}

function fieldError(field: string, message: string): AppError {
  return new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', message, [{ field, code: 'INVALID', message }]);
}

function feeItemView(r: { id: string; code: string; name: string; category: string; is_optional: boolean; is_active: boolean; allocation_priority: number }) {
  return { id: r.id, code: r.code, name: r.name, category: r.category, isOptional: r.is_optional, isActive: r.is_active, allocationPriority: r.allocation_priority };
}
