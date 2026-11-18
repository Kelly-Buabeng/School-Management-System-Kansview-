import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes, addPesewas } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { IDEMPOTENCY_SERVICE, type IdempotencyService } from '../../security/idempotency';
import { SCOPE_SERVICE, type ScopeService } from '../../security/scope.service';
import {
  adjustmentEntry, assertCanDecide, assertWithinLimit, resolveAdjustmentAmount, splitBalance, suggestSiblingDiscounts,
  type AdjustmentStatus, type AdjustmentType,
} from './domain';
import type { AdjustmentBody } from './dto';
import { FinanceStore, toIso } from './finance-store';
import { assertStudentInScope, fullName, requireIdempotencyKey } from './support';

const TYPE_LABEL: Record<AdjustmentType, string> = {
  discount: 'Discount', scholarship: 'Scholarship', bursary: 'Bursary', sibling_discount: 'Sibling discount', waiver: 'Waiver',
  refund: 'Refund', write_off: 'Write-off', manual_charge: 'Charge',
};

@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly store: FinanceStore,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IdempotencyService,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
  ) {}

  async request(body: AdjustmentBody, idempotencyKey: string | undefined, user: AuthUser) {
    const key = requireIdempotencyKey(idempotencyKey);
    await assertStudentInScope(this.scope, user, body.studentId);
    const res = await this.idempotency.run(key, 'POST /adjustments', body, user, async () => {
      const out = await this.db.transaction().execute(async (tx) => {
        const st = await tx.selectFrom('students').select('id').where('id', '=', body.studentId).executeTakeFirst();
        if (!st) throw AppError.notFound('student');
        const term = await tx.selectFrom('terms').select('id').where('id', '=', body.termId).executeTakeFirst();
        if (!term) throw fieldError('termId', 'Term not found');
        if (body.feeItemId && !(await tx.selectFrom('fee_items').select('id').where('id', '=', body.feeItemId).executeTakeFirst())) throw fieldError('feeItemId', 'Fee item not found');
        const base = body.percentBasisPoints != null ? await this.percentBase(tx, body.studentId, body.termId, body.feeItemId ?? null) : 0;
        const amount = resolveAdjustmentAmount({ amountPesewas: body.amountPesewas, percentBasisPoints: body.percentBasisPoints }, base);
        const row = await tx.insertInto('adjustments').values({
          student_id: body.studentId, term_id: body.termId, type: body.type, fee_item_id: body.feeItemId ?? null, amount_pesewas: amount,
          percent_bp: body.percentBasisPoints ?? null, reason: body.reason, status: 'pending', requested_by: user.id, created_by: user.id, updated_by: user.id,
        }).returning('id').executeTakeFirstOrThrow();
        await this.audit.record({ action: 'create', entityType: 'adjustment', entityId: row.id, studentId: body.studentId, changes: { type: { after: body.type }, amountPesewas: { after: amount } }, reason: body.reason }, user, tx);
        return this.view(tx, row.id);
      });
      return { status: 201, body: out };
    });
    return { status: res.status, body: res.body };
  }

  /** Base for a percentage: the fee item's line on the term invoice, or the whole term invoice. */
  private async percentBase(db: Db | Tx, studentId: string, termId: string, feeItemId: string | null): Promise<number> {
    let q = db.selectFrom('invoice_lines as il').innerJoin('invoices as i', 'i.id', 'il.invoice_id')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('il.amount_pesewas'), eb.val('0')).as('s'))
      .where('i.student_id', '=', studentId).where('i.term_id', '=', termId).where('i.status', '=', 'issued');
    if (feeItemId) q = q.where('il.fee_item_id', '=', feeItemId);
    return Number((await q.executeTakeFirstOrThrow()).s);
  }

  async approve(id: string, reason: string | undefined, user: AuthUser) {
    return this.decide(id, user, async (tx, adj) => {
      const amount = Number(adj.amount_pesewas);
      const type = adj.type as AdjustmentType;
      const lines = await this.store.lineStates(tx, adj.student_id);
      const target = lines.filter((l) => l.termId === adj.term_id && (adj.fee_item_id === null || l.feeItemId === adj.fee_item_id));
      const owed = addPesewas(0, ...target.map((l) => Math.max(0, l.outstandingPesewas)));
      assertWithinLimit(type, amount, { targetOwedPesewas: owed, creditPesewas: splitBalance(await this.store.balance(tx, adj.student_id)).creditPesewas });
      await tx.updateTable('adjustments').set({ status: 'approved', approved_by: user.id, approved_at: new Date(), decision_reason: reason ?? null, updated_by: user.id }).where('id', '=', id).execute();
      await this.store.postLedger(tx, [{
        studentId: adj.student_id, termId: adj.term_id, entryType: 'adjustment', amountPesewas: adjustmentEntry(type, amount), adjustmentId: id,
        description: `${TYPE_LABEL[type]}: ${adj.reason}`, postedBy: user.id,
      }]);
      await this.store.reconcileCredit(tx, adj.student_id, user.id);
      await this.audit.record({ action: 'approve', entityType: 'adjustment', entityId: id, studentId: adj.student_id, changes: { status: { before: 'pending', after: 'approved' } }, reason: reason ?? null }, user, tx);
    });
  }

  async reject(id: string, reason: string | undefined, user: AuthUser) {
    return this.decide(id, user, async (tx, adj) => {
      await tx.updateTable('adjustments').set({ status: 'rejected', approved_by: user.id, approved_at: new Date(), rejected_reason: reason ?? null, decision_reason: reason ?? null, updated_by: user.id }).where('id', '=', id).execute();
      await this.audit.record({ action: 'update', entityType: 'adjustment', entityId: id, studentId: adj.student_id, changes: { status: { before: 'pending', after: 'rejected' } }, reason: reason ?? null }, user, tx);
    });
  }

  private async decide(id: string, user: AuthUser, fn: (tx: Tx, adj: { id: string; student_id: string; term_id: string | null; fee_item_id: string | null; type: string; amount_pesewas: number; reason: string }) => Promise<void>) {
    const head = await this.db.selectFrom('adjustments').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!head) throw AppError.notFound('adjustment');
    await assertStudentInScope(this.scope, user, head.student_id);
    return this.db.transaction().execute(async (tx) => {
      await this.store.lockStudent(tx, head.student_id);
      const adj = await tx.selectFrom('adjustments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      assertCanDecide({ status: adj.status as AdjustmentStatus, requestedBy: adj.requested_by, type: adj.type as AdjustmentType }, { id: user.id, roles: user.roles });
      await fn(tx, adj);
      return this.view(tx, id);
    });
  }

  async reverse(id: string, reason: string, user: AuthUser) {
    const head = await this.db.selectFrom('adjustments').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!head) throw AppError.notFound('adjustment');
    await assertStudentInScope(this.scope, user, head.student_id);
    return this.db.transaction().execute(async (tx) => {
      await this.store.lockStudent(tx, head.student_id);
      const adj = await tx.selectFrom('adjustments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      if (adj.status !== 'approved') throw new AppError(409, ErrorCodes.ADJUSTMENT_INVALID_STATE, 'Only an approved adjustment can be reversed', `It is ${adj.status}.`);
      const type = adj.type as AdjustmentType;
      const orig = await tx.selectFrom('ledger_entries').select(['id', 'amount_pesewas', 'term_id']).where('adjustment_id', '=', id).where('entry_type', '=', 'adjustment').executeTakeFirstOrThrow();
      await this.store.postLedger(tx, [{
        studentId: adj.student_id, termId: orig.term_id, entryType: 'reversal', amountPesewas: -Number(orig.amount_pesewas), adjustmentId: id,
        reversesEntryId: orig.id, description: `Reversal of ${TYPE_LABEL[type].toLowerCase()}: ${reason}`, postedBy: user.id,
      }]);
      await tx.updateTable('adjustments').set({ status: 'reversed', reversed_by: user.id, reversed_at: new Date(), reversal_reason: reason, updated_by: user.id }).where('id', '=', id).execute();
      await this.store.reconcileCredit(tx, adj.student_id, user.id);
      await this.audit.record({ action: 'reverse', entityType: 'adjustment', entityId: id, studentId: adj.student_id, changes: { status: { before: 'approved', after: 'reversed' } }, reason }, user, tx);
      return this.view(tx, id);
    });
  }

  async list(q: { status?: string; studentId?: string }, user: AuthUser) {
    if (q.studentId) await assertStudentInScope(this.scope, user, q.studentId);
    let base = this.db.selectFrom('adjustments').select('id').orderBy('requested_at', 'desc').limit(500);
    if (q.status) base = base.where('status', '=', q.status as AdjustmentStatus);
    if (q.studentId) base = base.where('student_id', '=', q.studentId);
    const ids = await base.execute();
    return { data: await Promise.all(ids.map((r) => this.view(this.db, r.id))) };
  }

  async view(db: Db | Tx, id: string) {
    const a = await db.selectFrom('adjustments as a').innerJoin('students as s', 's.id', 'a.student_id').leftJoin('fee_items as fi', 'fi.id', 'a.fee_item_id')
      .selectAll('a').select(['s.student_code', 's.first_name', 's.middle_names', 's.last_name', 'fi.name as fee_item_name']).where('a.id', '=', id).executeTakeFirstOrThrow();
    return {
      id: a.id, studentId: a.student_id, studentCode: a.student_code, studentName: fullName(a.first_name, a.middle_names, a.last_name),
      termId: a.term_id, type: a.type, feeItemId: a.fee_item_id, feeItemName: a.fee_item_name, amountPesewas: Number(a.amount_pesewas),
      percentBasisPoints: a.percent_bp, reason: a.reason, status: a.status, requestedBy: a.requested_by, requestedAt: toIso(a.requested_at),
      approvedBy: a.approved_by, approvedAt: a.approved_at ? toIso(a.approved_at) : null, decisionReason: a.decision_reason,
      reversedBy: a.reversed_by, reversedAt: a.reversed_at ? toIso(a.reversed_at) : null, reversalReason: a.reversal_reason,
      needsAdmin: a.type === 'refund' || a.type === 'write_off',
    };
  }

  /** Suggestion only: siblings through shared guardians (v_sibling_links). A discount still has to be requested and approved. */
  async siblingSuggestions(studentId: string, termId: string, user: AuthUser) {
    await assertStudentInScope(this.scope, user, studentId);
    if (!(await this.store.studentExists(this.db, studentId))) throw AppError.notFound('student');
    const sibs = await this.db.selectFrom('v_sibling_links').select('sibling_student_id').where('student_id', '=', studentId).execute();
    const ids = [studentId, ...sibs.map((s) => s.sibling_student_id).filter((x): x is string => !!x)];
    const kids = await this.db.selectFrom('students as s')
      .leftJoin((eb) => eb.selectFrom('invoice_lines as il').innerJoin('invoices as i', 'i.id', 'il.invoice_id').innerJoin('fee_items as fi', 'fi.id', 'il.fee_item_id')
        .select(['i.student_id', (e) => e.fn.sum<string>('il.amount_pesewas').as('tuition')])
        .where('i.term_id', '=', termId).where('i.status', '=', 'issued').where('fi.category', '=', 'tuition').groupBy('i.student_id').as('t'), (j) => j.onRef('t.student_id', '=', 's.id'))
      .select(['s.id', 's.date_of_birth', 's.status', 's.student_code', 's.first_name', 's.last_name', 't.tuition'])
      .where('s.id', 'in', ids).where('s.status', '=', 'active').execute();
    const bp = Number(await this.store.setting<number>(this.db, 'finance.sibling_discount_bp', 1000));
    const minChildren = Number(await this.store.setting<number>(this.db, 'finance.sibling_discount_min_children', 2));
    const suggestions = suggestSiblingDiscounts(kids.map((k) => ({ studentId: k.id, dateOfBirth: String(k.date_of_birth), tuitionPesewas: Number(k.tuition ?? 0) })), { basisPoints: bp, minChildren });
    return {
      studentId, termId, basisPoints: bp,
      siblings: kids.map((k) => ({ studentId: k.id, studentCode: k.student_code, studentName: `${k.first_name} ${k.last_name}`, tuitionPesewas: Number(k.tuition ?? 0) })),
      suggestions,
      thisStudent: suggestions.find((s) => s.studentId === studentId) ?? null,
    };
  }
}

function fieldError(field: string, message: string): AppError {
  return new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', message, [{ field, code: 'INVALID', message }]);
}
