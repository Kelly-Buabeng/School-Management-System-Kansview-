import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCodes, addPesewas, todayInAccra, type Pesewas } from '@sms/shared';
import type { z } from 'zod';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { IDEMPOTENCY_SERVICE, type IdempotencyService } from '../../security/idempotency';
import { SCOPE_SERVICE, type ScopeService } from '../../security/scope.service';
import { PDF_SERVICE, type PdfService } from '../../common/contracts';
import { pickStructure, planInvoiceLines, totalOf, type PlannedInvoiceLine, type StructureLine } from './domain';
import type { GenerateInvoicesBody, ListInvoicesQuery } from './dto';
import { FinanceStore } from './finance-store';
import { assertStudentInScope, fullName, requireIdempotencyKey } from './support';

type GenerateBody = z.infer<typeof GenerateInvoicesBody>;

interface Candidate {
  studentId: string;
  studentCode: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  levelId: string | null;
}

interface Problem {
  studentId: string;
  studentCode: string;
  studentName: string;
  code: 'NO_ACTIVE_STRUCTURE' | 'NOT_ENROLLED' | 'NOTHING_TO_BILL' | 'NOT_ACTIVE';
  message: string;
}

interface Planned extends Candidate {
  structureId: string;
  lines: PlannedInvoiceLine[];
  totalPesewas: Pesewas;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly store: FinanceStore,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IdempotencyService,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
    @Inject(PDF_SERVICE) private readonly pdfService: PdfService,
  ) {}

  /** Preview (dryRun) or issue invoices for a term and scope. Students already invoiced for the term are skipped. */
  async generate(body: GenerateBody, idempotencyKey: string | undefined, user: AuthUser): Promise<{ status: number; body: unknown }> {
    if (body.scope.type !== 'school' && (!body.scope.ids || body.scope.ids.length === 0)) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Choose at least one student, class or level.', [
        { field: 'scope.ids', code: 'REQUIRED', message: 'Choose at least one' },
      ]);
    }
    if (body.dryRun) {
      const plan = await this.plan(this.db, body);
      return { status: 200, body: this.summary(plan, true) };
    }
    const key = requireIdempotencyKey(idempotencyKey);
    const res = await this.idempotency.run(key, 'POST /invoices/generate', body, user, async () => {
      const out = await this.db.transaction().execute(async (tx) => this.issue(tx, body, user));
      return { status: 201, body: out };
    });
    return { status: res.status, body: res.body };
  }

  private async plan(db: Db | Tx, body: GenerateBody) {
    const term = await db.selectFrom('terms').select(['id', 'academic_year_id', 'name', 'start_date']).where('id', '=', body.termId).executeTakeFirst();
    if (!term) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Term not found', [{ field: 'termId', code: 'INVALID', message: 'Term not found' }]);
    const candidates = await this.candidates(db, body, term.academic_year_id);
    const problems: Problem[] = [];
    const invoiced = candidates.length === 0 ? [] : await db.selectFrom('invoices').select('student_id').where('term_id', '=', term.id).where('status', '=', 'issued')
      .where('student_id', 'in', candidates.map((c) => c.studentId)).execute();
    const already = new Set(invoiced.map((r) => r.student_id));

    const structures = (await db.selectFrom('fee_structures').select(['id', 'class_id', 'level_id']).where('term_id', '=', term.id).where('status', '=', 'active').execute())
      .map((s) => ({ id: s.id, classId: s.class_id, levelId: s.level_id }));
    const lines = structures.length === 0 ? [] : await db.selectFrom('fee_structure_lines as fl').innerJoin('fee_items as fi', 'fi.id', 'fl.fee_item_id')
      .select(['fl.fee_structure_id', 'fl.fee_item_id', 'fl.amount_pesewas', 'fl.is_optional', 'fi.name', 'fi.allocation_priority'])
      .where('fl.fee_structure_id', 'in', structures.map((s) => s.id)).orderBy('fi.allocation_priority').orderBy('fi.code').execute();
    const linesBy = new Map<string, StructureLine[]>();
    for (const l of lines) {
      const arr = linesBy.get(l.fee_structure_id) ?? [];
      arr.push({ feeItemId: l.fee_item_id, feeItemName: l.name, amountPesewas: Number(l.amount_pesewas), isOptional: l.is_optional, allocationPriority: l.allocation_priority });
      linesBy.set(l.fee_structure_id, arr);
    }
    const todo = candidates.filter((c) => !already.has(c.studentId));
    const opts = todo.length === 0 ? [] : await db.selectFrom('student_optional_items').select(['student_id', 'fee_item_id']).where('term_id', '=', term.id).where('opted_in', '=', true)
      .where('student_id', 'in', todo.map((c) => c.studentId)).execute();
    const optBy = new Map<string, Set<string>>();
    for (const o of opts) optBy.set(o.student_id, (optBy.get(o.student_id) ?? new Set()).add(o.fee_item_id));

    const planned: Planned[] = [];
    for (const c of todo) {
      const base = { studentId: c.studentId, studentCode: c.studentCode, studentName: c.studentName };
      if (!c.levelId) {
        problems.push({ ...base, code: 'NOT_ENROLLED', message: `${c.studentName} is not in a class for this academic year.` });
        continue;
      }
      const s = pickStructure(structures, { classId: c.classId, levelId: c.levelId });
      if (!s) {
        problems.push({ ...base, code: 'NO_ACTIVE_STRUCTURE', message: `No active fee structure for ${c.className ?? 'this class'} this term.` });
        continue;
      }
      const pl = planInvoiceLines(linesBy.get(s.id) ?? [], optBy.get(c.studentId) ?? new Set());
      if (pl.length === 0) {
        problems.push({ ...base, code: 'NOTHING_TO_BILL', message: `Nothing to bill for ${c.studentName}.` });
        continue;
      }
      planned.push({ ...c, structureId: s.id, lines: pl, totalPesewas: totalOf(pl) });
    }
    return { term, candidates, alreadyInvoiced: candidates.filter((c) => already.has(c.studentId)), planned, problems };
  }

  private summary(plan: Awaited<ReturnType<InvoicesService['plan']>>, dryRun: boolean, issued?: Array<{ invoiceId: string; invoiceNo: string; studentId: string; totalPesewas: number; openingBalancePesewas: number; creditAppliedPesewas: number }>, batchId?: string) {
    const byClass = new Map<string, { classId: string | null; className: string | null; count: number; totalPesewas: number }>();
    for (const p of plan.planned) {
      const k = p.classId ?? '-';
      const e = byClass.get(k) ?? { classId: p.classId, className: p.className, count: 0, totalPesewas: 0 };
      e.count += 1;
      e.totalPesewas = addPesewas(e.totalPesewas, p.totalPesewas);
      byClass.set(k, e);
    }
    return {
      dryRun,
      termId: plan.term.id,
      termName: plan.term.name,
      generationBatchId: batchId ?? null,
      counts: { candidates: plan.candidates.length, toInvoice: plan.planned.length, alreadyInvoiced: plan.alreadyInvoiced.length, problems: plan.problems.length },
      totalPesewas: addPesewas(0, ...plan.planned.map((p) => p.totalPesewas)),
      byClass: [...byClass.values()],
      problems: plan.problems,
      ...(dryRun
        ? { preview: plan.planned.slice(0, 50).map((p) => ({ studentId: p.studentId, studentCode: p.studentCode, studentName: p.studentName, className: p.className, totalPesewas: p.totalPesewas, lines: p.lines })) }
        : { invoices: issued ?? [] }),
    };
  }

  private async issue(tx: Tx, body: GenerateBody, user: AuthUser) {
    const plan = await this.plan(tx, body);
    const batchId = await this.store.newBatchId(tx);
    const issueDate = body.issueDate ?? todayInAccra();
    const issued: Array<{ invoiceId: string; invoiceNo: string; studentId: string; totalPesewas: number; openingBalancePesewas: number; creditAppliedPesewas: number }> = [];
    for (const p of plan.planned) {
      await this.store.lockStudent(tx, p.studentId);
      const exists = await tx.selectFrom('invoices').select('id').where('student_id', '=', p.studentId).where('term_id', '=', plan.term.id).where('status', '=', 'issued').executeTakeFirst();
      if (exists) continue; // issued by someone else meanwhile: skip, like any already-invoiced student
      const opening = await this.store.balance(tx, p.studentId);
      const invoiceNo = await this.store.nextDocNo(tx, 'invoice');
      const inv = await tx.insertInto('invoices').values({
        invoice_no: invoiceNo, student_id: p.studentId, term_id: plan.term.id, class_id: p.classId, issue_date: issueDate,
        due_date: body.dueDate ?? null, opening_balance_pesewas: opening, total_pesewas: p.totalPesewas, status: 'issued',
        generation_batch_id: batchId, created_by: user.id, updated_by: user.id,
      }).returning('id').executeTakeFirstOrThrow();
      const lineRows = await tx.insertInto('invoice_lines').values(p.lines.map((l) => ({
        invoice_id: inv.id, fee_item_id: l.feeItemId, description: l.description, amount_pesewas: l.amountPesewas, allocation_priority: l.allocationPriority, created_by: user.id,
      }))).returning(['id', 'amount_pesewas', 'description']).execute();
      await this.store.postLedger(tx, lineRows.map((l) => ({
        studentId: p.studentId, termId: plan.term.id, entryType: 'invoice_charge' as const, amountPesewas: Number(l.amount_pesewas),
        invoiceLineId: l.id, description: `${invoiceNo} ${l.description}`, postedBy: user.id,
      })));
      const credit = await this.store.reconcileCredit(tx, p.studentId, user.id);
      await this.audit.record({
        action: 'create', entityType: 'invoice', entityId: inv.id, studentId: p.studentId,
        changes: { invoiceNo: { after: invoiceNo }, totalPesewas: { after: p.totalPesewas }, openingBalancePesewas: { after: opening }, creditAppliedPesewas: { after: credit } },
      }, user, tx);
      issued.push({ invoiceId: inv.id, invoiceNo, studentId: p.studentId, totalPesewas: p.totalPesewas, openingBalancePesewas: opening, creditAppliedPesewas: credit });
    }
    this.logger.log({ batchId, termId: plan.term.id, issued: issued.length, problems: plan.problems.length }, 'invoices generated');
    return this.summary({ ...plan, planned: plan.planned.filter((p) => issued.some((i) => i.studentId === p.studentId)) }, false, issued, batchId);
  }

  private async candidates(db: Db | Tx, body: GenerateBody, academicYearId: string): Promise<Candidate[]> {
    let q = db.selectFrom('students as s')
      .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null).on('e.academic_year_id', '=', academicYearId))
      .leftJoin('classes as c', 'c.id', 'e.class_id')
      .select(['s.id', 's.student_code', 's.first_name', 's.middle_names', 's.last_name', 's.status', 'c.id as class_id', 'c.display_name', 'c.level_id'])
      .where('s.archived_at', 'is', null);
    const ids = body.scope.ids ?? [];
    switch (body.scope.type) {
      case 'student': q = q.where('s.id', 'in', ids); break;
      case 'class': q = q.where('c.id', 'in', ids).where('s.status', '=', 'active'); break;
      case 'level': q = q.where('c.level_id', 'in', ids).where('s.status', '=', 'active'); break;
      case 'school': q = q.where('e.id', 'is not', null).where('s.status', '=', 'active'); break;
    }
    const rows = await q.orderBy('c.display_name').orderBy('s.student_code').execute();
    return rows.filter((r) => r.status === 'active' || body.scope.type === 'student').map((r) => ({
      studentId: r.id, studentCode: r.student_code, studentName: fullName(r.first_name, r.middle_names, r.last_name),
      classId: r.class_id, className: r.display_name, levelId: r.level_id,
    }));
  }

  async void(id: string, reason: string, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const inv0 = await tx.selectFrom('invoices').select(['id', 'student_id']).where('id', '=', id).executeTakeFirst();
      if (!inv0) throw AppError.notFound('invoice');
      await assertStudentInScope(this.scope, user, inv0.student_id);
      await this.store.lockStudent(tx, inv0.student_id);
      const inv = await tx.selectFrom('invoices').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      if (inv.status !== 'issued') throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'This invoice is already void');
      const lines = await tx.selectFrom('invoice_lines').select('id').where('invoice_id', '=', id).execute();
      const lineIds = lines.map((l) => l.id);
      if (lineIds.length) {
        const alloc = await tx.selectFrom('payment_allocations').select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount_pesewas'), eb.val('0')).as('s')).where('invoice_line_id', 'in', lineIds).executeTakeFirstOrThrow();
        if (Number(alloc.s) !== 0) {
          throw new AppError(422, ErrorCodes.INVOICE_HAS_PAYMENTS, 'This invoice has payments on it', 'Move the payments off this invoice (re-allocate) before voiding it.', undefined, { allocatedPesewas: Number(alloc.s) });
        }
        const charges = await tx.selectFrom('ledger_entries').select(['id', 'amount_pesewas', 'invoice_line_id', 'term_id']).where('invoice_line_id', 'in', lineIds).where('entry_type', '=', 'invoice_charge').execute();
        await this.store.postLedger(tx, charges.map((c) => ({
          studentId: inv.student_id, termId: c.term_id, entryType: 'reversal' as const, amountPesewas: -Number(c.amount_pesewas),
          invoiceLineId: c.invoice_line_id, reversesEntryId: c.id, description: `Void ${inv.invoice_no}: ${reason}`, postedBy: user.id,
        })));
      }
      await tx.updateTable('invoices').set({ status: 'void', void_reason: reason, voided_at: new Date(), voided_by: user.id, updated_by: user.id }).where('id', '=', id).execute();
      await this.store.reconcileCredit(tx, inv.student_id, user.id);
      await this.audit.record({ action: 'reverse', entityType: 'invoice', entityId: id, studentId: inv.student_id, changes: { status: { before: 'issued', after: 'void' } }, reason }, user, tx);
      return this.view(tx, id);
    });
  }

  async get(id: string, user: AuthUser) {
    const inv = await this.db.selectFrom('invoices').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!inv) throw AppError.notFound('invoice');
    await assertStudentInScope(this.scope, user, inv.student_id);
    return this.view(this.db, id);
  }

  async view(db: Db | Tx, id: string) {
    const inv = await db.selectFrom('invoices as i').innerJoin('students as s', 's.id', 'i.student_id').innerJoin('terms as t', 't.id', 'i.term_id').leftJoin('classes as c', 'c.id', 'i.class_id')
      .select(['i.id', 'i.invoice_no', 'i.student_id', 'i.term_id', 'i.class_id', 'i.issue_date', 'i.due_date', 'i.opening_balance_pesewas', 'i.total_pesewas', 'i.status', 'i.void_reason', 'i.voided_at', 'i.created_at',
        's.student_code', 's.first_name', 's.middle_names', 's.last_name', 't.name as term_name', 'c.display_name as class_name'])
      .where('i.id', '=', id).executeTakeFirstOrThrow();
    const states = inv.status === 'issued' ? (await this.store.lineStates(db, inv.student_id)).filter((l) => l.invoiceId === id) : [];
    const rawLines = await db.selectFrom('invoice_lines').select(['id', 'fee_item_id', 'description', 'amount_pesewas']).where('invoice_id', '=', id).orderBy('allocation_priority').orderBy('id').execute();
    const lines = rawLines.map((l) => {
      const s = states.find((x) => x.invoiceLineId === l.id);
      return {
        id: l.id, feeItemId: l.fee_item_id, feeItemName: s?.feeItemName ?? l.description, description: l.description, amountPesewas: Number(l.amount_pesewas),
        paidPesewas: s?.paidPesewas ?? 0, adjustmentsPesewas: s?.reductionPesewas ?? 0, outstandingPesewas: s ? Math.max(0, s.outstandingPesewas) : 0,
      };
    });
    const paid = addPesewas(0, ...lines.map((l) => l.paidPesewas));
    const adj = addPesewas(0, ...lines.map((l) => l.adjustmentsPesewas));
    return {
      id: inv.id, invoiceNo: inv.invoice_no, studentId: inv.student_id, studentCode: inv.student_code, studentName: fullName(inv.first_name, inv.middle_names, inv.last_name),
      termId: inv.term_id, termName: inv.term_name, classId: inv.class_id, className: inv.class_name, issueDate: inv.issue_date, dueDate: inv.due_date,
      status: inv.status, voidReason: inv.void_reason, voidedAt: inv.voided_at,
      openingBalancePesewas: Number(inv.opening_balance_pesewas), totalPesewas: Number(inv.total_pesewas),
      paidPesewas: paid, adjustmentsPesewas: adj, outstandingPesewas: addPesewas(0, ...lines.map((l) => l.outstandingPesewas)),
      lines,
    };
  }

  async list(q: z.infer<typeof ListInvoicesQuery>, user: AuthUser) {
    if (q.studentId) await assertStudentInScope(this.scope, user, q.studentId);
    let base = this.db.selectFrom('invoices as i').innerJoin('students as s', 's.id', 'i.student_id');
    if (q.termId) base = base.where('i.term_id', '=', q.termId);
    if (q.classId) base = base.where('i.class_id', '=', q.classId);
    if (q.studentId) base = base.where('i.student_id', '=', q.studentId);
    if (q.status) base = base.where('i.status', '=', q.status);
    const allowed = await this.scope.allowedClassIds(user);
    if (allowed !== null) base = allowed.length ? base.where('i.class_id', 'in', allowed) : base.where(({ lit }) => lit(false));
    const total = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const rows = await base.select(['i.id', 'i.invoice_no', 'i.student_id', 'i.term_id', 'i.class_id', 'i.issue_date', 'i.total_pesewas', 'i.opening_balance_pesewas', 'i.status', 's.student_code', 's.first_name', 's.middle_names', 's.last_name'])
      .orderBy('i.invoice_no', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    const ids = rows.map((r) => r.id);
    const paid = ids.length === 0 ? [] : await this.db.selectFrom('payment_allocations as pa').innerJoin('invoice_lines as il', 'il.id', 'pa.invoice_line_id')
      .select(['il.invoice_id', (eb) => eb.fn.sum<string>('pa.amount_pesewas').as('paid')]).where('il.invoice_id', 'in', ids).groupBy('il.invoice_id').execute();
    const pm = new Map(paid.map((p) => [p.invoice_id, Number(p.paid)]));
    return {
      data: rows.map((r) => ({
        id: r.id, invoiceNo: r.invoice_no, studentId: r.student_id, studentCode: r.student_code, studentName: fullName(r.first_name, r.middle_names, r.last_name),
        termId: r.term_id, classId: r.class_id, issueDate: r.issue_date, status: r.status,
        totalPesewas: Number(r.total_pesewas), openingBalancePesewas: Number(r.opening_balance_pesewas), paidPesewas: pm.get(r.id) ?? 0,
      })),
      page: q.page, pageSize: q.pageSize, total: Number(total.n),
    };
  }

  async pdf(id: string, user: AuthUser): Promise<Buffer> {
    const view = await this.get(id, user);
    const buf = await this.pdfService.render('invoice', view as unknown as Record<string, unknown>, view.status === 'void' ? { watermark: 'REVERSED' } : undefined);
    await this.audit.record({ action: 'export', entityType: 'invoice', entityId: id, studentId: view.studentId }, user);
    return buf;
  }
}
