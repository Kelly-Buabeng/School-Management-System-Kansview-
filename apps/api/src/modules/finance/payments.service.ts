import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes, addPesewas, formatCedis, todayInAccra, type Pesewas } from '@sms/shared';
import type { z } from 'zod';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { PDF_SERVICE, type PdfService } from '../../common/contracts';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { IDEMPOTENCY_SERVICE, type IdempotencyService } from '../../security/idempotency';
import { SCOPE_SERVICE, type ScopeService } from '../../security/scope.service';
import { UPLOAD_PIPELINE, UPLOAD_POLICIES, type UploadPipeline } from '../../security/upload-pipeline';
import {
  allocatePayment, methodLabel, netAllocations, paymentEntry, reallocationRows, referenceKey, reversalRows,
  validateExplicitAllocations, validateReference, type PaymentMethod,
} from './domain';
import type { DuplicateCheckQuery, ListPaymentsQuery, RecordPaymentBody } from './dto';
import { FinanceStore, toIso } from './finance-store';
import { assertStudentInScope, fullName, isUniqueViolation, requestHash, requireIdempotencyKey } from './support';

export interface PaymentView {
  id: string;
  receiptNo: string;
  studentId: string;
  studentCode: string;
  studentName: string;
  payerGuardianId: string | null;
  payerName: string;
  amountPesewas: Pesewas;
  method: PaymentMethod;
  referenceNo: string | null;
  bankName: string | null;
  chequeNo: string | null;
  status: 'confirmed' | 'reversed';
  /** v1: always 'manual'. v2 hook: 'gateway'. */
  source: string;
  /** v2 hook (gateway transaction id); always null in v1. */
  externalReference: string | null;
  provider: string | null;
  receivedAt: string;
  recordedBy: string;
  recordedByName: string | null;
  notes: string | null;
  cashUpId: string | null;
  attachmentFileId: string | null;
  duplicateOverrideReason: string | null;
  allocations: Array<{ invoiceLineId: string | null; feeItemName: string; termId: string | null; amountPesewas: Pesewas }>;
  creditCreatedPesewas: Pesewas;
  balanceAfterPesewas: Pesewas;
  reversal: { reversedAt: string | null; reversedBy: string | null; reason: string; reversalNo: string | null; status: string; requestedBy: string; requestedAt: string } | null;
}

/** Test seam: lets the crash test throw inside the payment transaction after allocations are written. */
export interface PaymentFaults {
  afterAllocations?: () => void | Promise<void>;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  readonly faults: PaymentFaults = {};

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly store: FinanceStore,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IdempotencyService,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
    @Inject(PDF_SERVICE) private readonly pdf: PdfService,
    @Inject(UPLOAD_PIPELINE) private readonly uploads: UploadPipeline,
  ) {}

  // ---------------------------------------------------------------- record
  async record(body: RecordPaymentBody, idempotencyKey: string | undefined, user: AuthUser): Promise<{ status: number; body: PaymentView; replayed: boolean }> {
    const key = requireIdempotencyKey(idempotencyKey);
    const hash = requestHash(body);
    // Our own check first: payments.idempotency_key is unique, so a replay is safe even if the generic store lost its record.
    const prior = await this.findByKey(this.db, key, hash);
    if (prior) return { status: 201, body: prior, replayed: true };
    await assertStudentInScope(this.scope, user, body.studentId);
    const res = await this.idempotency.run(key, 'POST /payments', body, user, async () => {
      try {
        const out = await this.db.transaction().execute((tx) => this.recordInTx(tx, body, key, hash, user));
        return { status: 201, body: out };
      } catch (e) {
        if (isUniqueViolation(e, 'payments_idempotency_key_key')) {
          const again = await this.findByKey(this.db, key, hash);
          if (again) return { status: 201, body: again };
        }
        throw e;
      }
    });
    return { status: res.status, body: res.body, replayed: res.replayed };
  }

  private async findByKey(db: Db | Tx, key: string, hash: string): Promise<PaymentView | null> {
    const p = await db.selectFrom('payments').select(['id', 'idempotency_request_hash']).where('idempotency_key', '=', key).executeTakeFirst();
    if (!p) return null;
    if (p.idempotency_request_hash && p.idempotency_request_hash !== hash) {
      throw new AppError(422, ErrorCodes.IDEMPOTENCY_KEY_REUSED, 'This form was already used for a different payment', 'Open a new payment form and enter the payment again.', undefined, { existingPaymentId: p.id });
    }
    return this.view(db, p.id);
  }

  private async recordInTx(tx: Tx, body: RecordPaymentBody, key: string, hash: string, user: AuthUser): Promise<PaymentView> {
    const student = await tx.selectFrom('students').select(['id', 'first_name', 'middle_names', 'last_name']).where('id', '=', body.studentId).executeTakeFirst();
    if (!student) throw AppError.notFound('student');
    await this.store.lockStudent(tx, body.studentId);
    const prior = await this.findByKey(tx, key, hash);
    if (prior) return prior;

    const ref = validateReference(body.method, body.referenceNo);
    let payerName = body.payerName?.trim() || null;
    if (body.payerGuardianId) {
      const g = await tx.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
        .select(['g.first_name', 'g.last_name']).where('sg.student_id', '=', body.studentId).where('sg.guardian_id', '=', body.payerGuardianId).executeTakeFirst();
      if (!g) {
        throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'This guardian is not linked to the student.', [{ field: 'payerGuardianId', code: 'INVALID', message: 'Not a guardian of this student' }]);
      }
      payerName ??= `${g.first_name} ${g.last_name}`;
    }
    if (!payerName) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Enter who paid.', [{ field: 'payerName', code: 'REQUIRED', message: 'Enter the payer name or choose a guardian' }]);
    }

    const rk = referenceKey(body.method, ref);
    if (rk) {
      const dup = await tx.selectFrom('payments as p').innerJoin('students as s', 's.id', 'p.student_id')
        .select(['p.id', 'p.receipt_no', 'p.received_at', 'p.amount_pesewas', 's.student_code'])
        .where('p.reference_key', '=', rk).where('p.status', '=', 'confirmed').orderBy('p.received_at').executeTakeFirst();
      if (dup) {
        if (!body.confirmDuplicate) {
          throw new AppError(409, ErrorCodes.PAYMENT_DUPLICATE_REFERENCE, 'This reference number was already recorded',
            `${methodLabel(body.method)} reference ${ref} was recorded on receipt ${dup.receipt_no} on ${todayInAccra(new Date(dup.received_at))} for ${dup.student_code}.`,
            [{ field: 'referenceNo', code: 'DUPLICATE', message: `Already used on receipt ${dup.receipt_no}` }],
            { existingPaymentId: dup.id, receiptNo: dup.receipt_no, canOverride: true });
        }
        if (!body.duplicateOverrideReason || body.duplicateOverrideReason.length < 5) {
          throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Say why this reference is being used again.', [
            { field: 'duplicateOverrideReason', code: 'REQUIRED', message: 'Reason is required to record a duplicate reference' },
          ]);
        }
      }
    }

    const today = todayInAccra();
    const requireCashUp = (await this.store.setting<boolean>(tx, 'finance.require_cash_up', false)) === true;
    const cashUp = await tx.selectFrom('cash_ups').select(['id']).where('business_date', '=', today).where('status', '=', 'open').executeTakeFirst();
    if (requireCashUp && !cashUp) {
      throw new AppError(422, ErrorCodes.CASH_UP_NOT_OPEN, "Open today's cash-up first", 'Payments can only be recorded while the cash-up for today is open.');
    }

    const lines = await this.store.lineStates(tx, body.studentId);
    const alloc = allocatePayment(body.amountPesewas, this.store.toOutstanding(lines), body.allocations);
    const receiptNo = await this.store.nextDocNo(tx, 'receipt');
    const payment = await tx.insertInto('payments').values({
      receipt_no: receiptNo, student_id: body.studentId, payer_guardian_id: body.payerGuardianId ?? null, payer_name: payerName,
      amount_pesewas: body.amountPesewas, method: body.method, reference_no: ref, bank_name: body.bankName ?? null,
      cheque_no: body.chequeNo ?? null, received_at: body.receivedAt, recorded_by: user.id, notes: body.notes ?? null,
      status: 'confirmed', source: 'manual', idempotency_key: key, idempotency_request_hash: hash,
      duplicate_override_reason: rk && body.confirmDuplicate ? body.duplicateOverrideReason ?? null : null,
      cash_up_id: cashUp?.id ?? null, created_by: user.id, updated_by: user.id,
    }).returning(['id']).executeTakeFirstOrThrow();

    const batch = await this.store.newBatchId(tx);
    const rows = alloc.allocations.map((a) => ({ paymentId: payment.id, invoiceLineId: a.invoiceLineId as string | null, amountPesewas: a.amountPesewas, allocationBatchId: batch, createdBy: user.id }));
    if (alloc.unallocatedPesewas > 0) rows.push({ paymentId: payment.id, invoiceLineId: null, amountPesewas: alloc.unallocatedPesewas, allocationBatchId: batch, createdBy: user.id });
    await this.store.insertAllocations(tx, rows);
    await this.faults.afterAllocations?.();

    await this.store.postLedger(tx, [{
      studentId: body.studentId, termId: await this.store.termForDate(tx, todayInAccra(new Date(body.receivedAt))), entryType: 'payment',
      amountPesewas: paymentEntry(body.amountPesewas), paymentId: payment.id,
      description: `Receipt ${receiptNo} (${methodLabel(body.method)}${ref ? ` ${ref}` : ''})`, postedBy: user.id,
    }]);
    await this.audit.record({
      action: 'create', entityType: 'payment', entityId: payment.id, studentId: body.studentId,
      changes: {
        receiptNo: { after: receiptNo }, amountPesewas: { after: body.amountPesewas }, method: { after: body.method }, referenceNo: { after: ref },
        ...(rk && body.confirmDuplicate ? { duplicateOverride: { after: true } } : {}),
      },
      reason: rk && body.confirmDuplicate ? `Duplicate reference override: ${body.duplicateOverrideReason}` : null,
    }, user, tx);
    this.logger.log({ paymentId: payment.id, receiptNo, studentId: body.studentId }, 'payment recorded');
    return this.view(tx, payment.id);
  }

  // ---------------------------------------------------------------- read
  async duplicateCheck(q: z.infer<typeof DuplicateCheckQuery>) {
    const rk = referenceKey(q.method, q.referenceNo);
    if (!rk) return { data: [] };
    const rows = await this.db.selectFrom('payments as p').innerJoin('students as s', 's.id', 'p.student_id')
      .select(['p.id', 'p.receipt_no', 'p.received_at', 'p.amount_pesewas', 'p.status', 's.student_code', 's.first_name', 's.middle_names', 's.last_name'])
      .where('p.reference_key', '=', rk).orderBy('p.received_at').execute();
    return {
      data: rows.map((r) => ({
        paymentId: r.id, receiptNo: r.receipt_no, receivedAt: toIso(r.received_at), amountPesewas: Number(r.amount_pesewas), status: r.status,
        studentCode: r.student_code, studentName: fullName(r.first_name, r.middle_names, r.last_name),
      })),
    };
  }

  async get(id: string, user: AuthUser): Promise<PaymentView> {
    const p = await this.db.selectFrom('payments').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!p) throw AppError.notFound('payment');
    await assertStudentInScope(this.scope, user, p.student_id);
    return this.view(this.db, id);
  }

  async list(q: z.infer<typeof ListPaymentsQuery>, user: AuthUser) {
    if (q.studentId) await assertStudentInScope(this.scope, user, q.studentId);
    let base = this.db.selectFrom('payments as p').innerJoin('students as s', 's.id', 'p.student_id');
    if (q.from) base = base.where(sql<string>`(p.received_at at time zone 'Africa/Accra')::date`, '>=', q.from);
    if (q.to) base = base.where(sql<string>`(p.received_at at time zone 'Africa/Accra')::date`, '<=', q.to);
    if (q.method) base = base.where('p.method', '=', q.method);
    if (q.studentId) base = base.where('p.student_id', '=', q.studentId);
    if (q.idempotencyKey) base = base.where('p.idempotency_key', '=', q.idempotencyKey);
    const total = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const rows = await base.select(['p.id', 'p.receipt_no', 'p.student_id', 'p.amount_pesewas', 'p.method', 'p.reference_no', 'p.status', 'p.source', 'p.received_at', 'p.payer_name', 's.student_code', 's.first_name', 's.middle_names', 's.last_name'])
      .orderBy('p.received_at', 'desc').orderBy('p.receipt_no', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    return {
      data: rows.map((r) => ({
        id: r.id, receiptNo: r.receipt_no, studentId: r.student_id, studentCode: r.student_code, studentName: fullName(r.first_name, r.middle_names, r.last_name),
        amountPesewas: Number(r.amount_pesewas), method: r.method, referenceNo: r.reference_no, status: r.status, source: r.source,
        receivedAt: toIso(r.received_at), payerName: r.payer_name,
      })),
      page: q.page, pageSize: q.pageSize, total: Number(total.n),
    };
  }

  async view(db: Db | Tx, id: string): Promise<PaymentView> {
    const p = await db.selectFrom('payments as p').innerJoin('students as s', 's.id', 'p.student_id').leftJoin('users as u', 'u.id', 'p.recorded_by')
      .selectAll('p').select(['s.student_code', 's.first_name', 's.middle_names', 's.last_name', 'u.full_name as recorder_name'])
      .where('p.id', '=', id).executeTakeFirst();
    if (!p) throw AppError.notFound('payment');
    const rows = await db.selectFrom('payment_allocations as pa').leftJoin('invoice_lines as il', 'il.id', 'pa.invoice_line_id').leftJoin('invoices as i', 'i.id', 'il.invoice_id').leftJoin('fee_items as fi', 'fi.id', 'il.fee_item_id')
      .select(['pa.invoice_line_id', 'pa.amount_pesewas', 'il.description', 'fi.name as fee_item_name', 'i.term_id']).where('pa.payment_id', '=', id).orderBy('pa.created_at').orderBy('pa.id').execute();
    const net = netAllocations(rows.map((r) => ({ invoiceLineId: r.invoice_line_id, amountPesewas: Number(r.amount_pesewas) })));
    const meta = new Map(rows.map((r) => [r.invoice_line_id, r]));
    const rev = await db.selectFrom('payment_reversals').selectAll().where('payment_id', '=', id).where('status', 'in', ['pending', 'approved']).executeTakeFirst();
    return {
      id: p.id, receiptNo: p.receipt_no, studentId: p.student_id, studentCode: p.student_code, studentName: fullName(p.first_name, p.middle_names, p.last_name),
      payerGuardianId: p.payer_guardian_id, payerName: p.payer_name, amountPesewas: Number(p.amount_pesewas), method: p.method as PaymentMethod,
      referenceNo: p.reference_no, bankName: p.bank_name, chequeNo: p.cheque_no, status: p.status as 'confirmed' | 'reversed', source: p.source,
      externalReference: p.external_reference, provider: p.provider, receivedAt: toIso(p.received_at), recordedBy: p.recorded_by, recordedByName: p.recorder_name,
      notes: p.notes, cashUpId: p.cash_up_id, attachmentFileId: p.attachment_file_id, duplicateOverrideReason: p.duplicate_override_reason,
      allocations: net.filter((n) => n.invoiceLineId !== null).map((n) => {
        const m = meta.get(n.invoiceLineId);
        return { invoiceLineId: n.invoiceLineId, feeItemName: m?.fee_item_name ?? m?.description ?? '', termId: m?.term_id ?? null, amountPesewas: n.amountPesewas };
      }),
      creditCreatedPesewas: net.find((n) => n.invoiceLineId === null)?.amountPesewas ?? 0,
      balanceAfterPesewas: await this.store.balance(db, p.student_id),
      reversal: rev ? {
        reversedAt: p.reversed_at ? toIso(p.reversed_at) : null, reversedBy: p.reversed_by, reason: rev.reason, reversalNo: rev.reversal_no,
        status: rev.status, requestedBy: rev.requested_by, requestedAt: toIso(rev.requested_at),
      } : null,
    };
  }

  // ---------------------------------------------------------------- reversal
  /**
   * Same business day and the day's cash-up still open: the bursar's reversal posts at once (200).
   * Otherwise a pending request is stored for the administrator to approve (202).
   */
  async reverse(id: string, reason: string, idempotencyKey: string | undefined, user: AuthUser): Promise<{ status: number; body: PaymentView }> {
    const key = requireIdempotencyKey(idempotencyKey);
    const head = await this.db.selectFrom('payments').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!head) throw AppError.notFound('payment');
    await assertStudentInScope(this.scope, user, head.student_id);
    const res = await this.idempotency.run(key, `POST /payments/${id}/reverse`, { reason }, user, async () =>
      this.db.transaction().execute(async (tx) => {
        await this.store.lockStudent(tx, head.student_id);
        const p = await tx.selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
        if (p.status === 'reversed') throw new AppError(409, ErrorCodes.PAYMENT_ALREADY_REVERSED, 'This payment was already reversed', `Receipt ${p.receipt_no} is already reversed.`);
        const pending = await tx.selectFrom('payment_reversals').select('id').where('payment_id', '=', id).where('status', '=', 'pending').executeTakeFirst();
        if (pending) throw new AppError(409, ErrorCodes.REVERSAL_NEEDS_APPROVAL, 'A reversal is already waiting for approval', 'The administrator needs to approve it.');
        const needsApproval = await this.needsApproval(tx, p);
        if (needsApproval) {
          await tx.insertInto('payment_reversals').values({ payment_id: id, reason, status: 'pending', requested_by: user.id, created_by: user.id }).execute();
          await this.audit.record({ action: 'reverse', entityType: 'payment', entityId: id, studentId: p.student_id, changes: { reversal: { after: 'pending_approval' } }, reason }, user, tx);
          return { status: 202, body: await this.view(tx, id) };
        }
        const rev = await tx.insertInto('payment_reversals').values({ payment_id: id, reason, status: 'approved', requested_by: user.id, created_by: user.id }).returning('id').executeTakeFirstOrThrow();
        await this.postReversal(tx, p.id, rev.id, reason, user);
        return { status: 200, body: await this.view(tx, id) };
      }),
    );
    return { status: res.status, body: res.body };
  }

  private async needsApproval(tx: Tx, p: { received_at: Date; cash_up_id: string | null }): Promise<boolean> {
    const policy = await this.store.setting<boolean>(tx, 'finance.reversal_after_cashup_requires_admin', true);
    if (policy === false) return false;
    const day = todayInAccra(new Date(p.received_at));
    if (day !== todayInAccra()) return true;
    const closed = await tx.selectFrom('cash_ups').select('id').where('status', '=', 'closed')
      .where((eb) => eb.or([eb('business_date', '=', day), ...(p.cash_up_id ? [eb('id', '=', p.cash_up_id)] : [])])).executeTakeFirst();
    return !!closed;
  }

  async approveReversal(id: string, user: AuthUser): Promise<PaymentView> {
    const head = await this.db.selectFrom('payments').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!head) throw AppError.notFound('payment');
    await assertStudentInScope(this.scope, user, head.student_id);
    return this.db.transaction().execute(async (tx) => {
      await this.store.lockStudent(tx, head.student_id);
      const rev = await tx.selectFrom('payment_reversals').selectAll().where('payment_id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (!rev) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'There is no reversal waiting for approval on this payment');
      if (rev.requested_by === user.id) throw new AppError(403, ErrorCodes.FORBIDDEN, 'You cannot approve your own reversal request', 'Another administrator must approve it.');
      await tx.updateTable('payment_reversals').set({ status: 'approved', approved_by: user.id, approved_at: new Date(), updated_by: user.id }).where('id', '=', rev.id).execute();
      await this.postReversal(tx, id, rev.id, rev.reason, user);
      await this.audit.record({ action: 'approve', entityType: 'payment_reversal', entityId: rev.id, studentId: head.student_id, reason: rev.reason }, user, tx);
      return this.view(tx, id);
    });
  }

  /** Reversal entry (reverses_entry_id), negative allocation rows, gap-free reversal number, status → reversed via the guarded function. */
  private async postReversal(tx: Tx, paymentId: string, reversalId: string, reason: string, user: AuthUser): Promise<void> {
    const p = await tx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirstOrThrow();
    const reversalNo = await this.store.nextDocNo(tx, 'reversal');
    const rows = await tx.selectFrom('payment_allocations').select(['invoice_line_id', 'amount_pesewas']).where('payment_id', '=', paymentId).execute();
    const batch = await this.store.newBatchId(tx);
    await this.store.insertAllocations(tx, reversalRows(rows.map((r) => ({ invoiceLineId: r.invoice_line_id, amountPesewas: Number(r.amount_pesewas) })))
      .map((r) => ({ paymentId, invoiceLineId: r.invoiceLineId, amountPesewas: r.amountPesewas, allocationBatchId: batch, createdBy: user.id })));
    const orig = await tx.selectFrom('ledger_entries').select(['id', 'amount_pesewas', 'term_id']).where('payment_id', '=', paymentId).where('entry_type', '=', 'payment').executeTakeFirstOrThrow();
    const [entry] = await this.store.postLedger(tx, [{
      studentId: p.student_id, termId: orig.term_id, entryType: 'reversal', amountPesewas: -Number(orig.amount_pesewas), paymentId,
      reversesEntryId: orig.id, description: `${reversalNo} reverses receipt ${p.receipt_no}: ${reason}`, postedBy: user.id,
    }]);
    await tx.updateTable('payment_reversals').set({ reversal_no: reversalNo, ledger_entry_id: entry!.id, updated_by: user.id }).where('id', '=', reversalId).execute();
    await sql`select app.mark_payment_reversed(${paymentId}::uuid, ${user.id}::uuid, ${reason})`.execute(tx);
    await this.store.reconcileCredit(tx, p.student_id, user.id);
    await this.audit.record({ action: 'reverse', entityType: 'payment', entityId: paymentId, studentId: p.student_id, changes: { status: { before: 'confirmed', after: 'reversed' }, reversalNo: { after: reversalNo } }, reason }, user, tx);
  }

  // ---------------------------------------------------------------- re-allocation
  async reallocate(id: string, allocations: Array<{ invoiceLineId: string; amountPesewas: number }>, user: AuthUser): Promise<PaymentView> {
    const head = await this.db.selectFrom('payments').select('student_id').where('id', '=', id).executeTakeFirst();
    if (!head) throw AppError.notFound('payment');
    await assertStudentInScope(this.scope, user, head.student_id);
    return this.db.transaction().execute(async (tx) => {
      await this.store.lockStudent(tx, head.student_id);
      const p = await tx.selectFrom('payments').select(['id', 'status', 'amount_pesewas', 'receipt_no']).where('id', '=', id).executeTakeFirstOrThrow();
      if (p.status !== 'confirmed') throw new AppError(409, ErrorCodes.PAYMENT_ALREADY_REVERSED, 'A reversed payment cannot be re-allocated');
      const current = (await tx.selectFrom('payment_allocations').select(['invoice_line_id', 'amount_pesewas']).where('payment_id', '=', id).execute())
        .map((r) => ({ invoiceLineId: r.invoice_line_id, amountPesewas: Number(r.amount_pesewas) }));
      const mine = new Map(netAllocations(current).filter((r) => r.invoiceLineId).map((r) => [r.invoiceLineId!, r.amountPesewas] as const));
      const lines = this.store.toOutstanding(await this.store.lineStates(tx, head.student_id)).map((l) => ({ ...l, outstandingPesewas: addPesewas(l.outstandingPesewas, mine.get(l.invoiceLineId) ?? 0) }));
      const amount = Number(p.amount_pesewas);
      const validated = validateExplicitAllocations(amount, allocations, lines);
      const rows = reallocationRows(current, validated.allocations, amount);
      const batch = await this.store.newBatchId(tx);
      await this.store.insertAllocations(tx, rows.map((r) => ({ paymentId: id, invoiceLineId: r.invoiceLineId, amountPesewas: r.amountPesewas, allocationBatchId: batch, createdBy: user.id })));
      await this.audit.record({ action: 'update', entityType: 'payment_allocation', entityId: id, studentId: head.student_id, changes: { allocations: { before: netAllocations(current), after: validated.allocations } } }, user, tx);
      return this.view(tx, id);
    });
  }

  // ---------------------------------------------------------------- attachment
  async attach(id: string, file: { originalname: string; buffer: Buffer; mimetype?: string } | undefined, user: AuthUser): Promise<PaymentView> {
    if (!file) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a file to upload', undefined, [{ field: 'file', code: 'REQUIRED', message: 'File is required' }]);
    const p = await this.get(id, user);
    if (p.cashUpId) {
      const cu = await this.db.selectFrom('cash_ups').select('status').where('id', '=', p.cashUpId).executeTakeFirst();
      if (cu?.status === 'closed') throw new AppError(422, ErrorCodes.CASH_UP_CLOSED, 'The cash-up for this day is closed', 'Evidence can only be added before the cash-up is closed.');
    }
    const accepted = await this.uploads.accept({ originalName: file.originalname, buffer: file.buffer, declaredMimeType: file.mimetype }, UPLOAD_POLICIES.paymentEvidence, user.id);
    try {
      await this.db.transaction().execute(async (tx) => {
        await tx.updateTable('payments').set({ attachment_file_id: accepted.fileId, updated_by: user.id }).where('id', '=', id).execute();
        await this.audit.record({ action: 'update', entityType: 'payment', entityId: id, studentId: p.studentId, changes: { attachmentFileId: { before: p.attachmentFileId, after: accepted.fileId } } }, user, tx);
      });
    } catch (e) {
      // The payments guard only allows confirmed → reversed (see CR-0004-C); report clearly instead of a 500.
      this.logger.warn({ paymentId: id, err: e }, 'payment attachment refused by database guard');
      throw new AppError(422, ErrorCodes.NOT_IMPLEMENTED, 'Evidence cannot be attached to a saved payment yet', 'Keep the slip with the receipt for now.');
    }
    return this.view(this.db, id);
  }

  // ---------------------------------------------------------------- receipt
  async receiptPdf(id: string, user: AuthUser): Promise<Buffer> {
    const p = await this.get(id, user);
    const printed = await this.previousPrints(id);
    const watermark = p.status === 'reversed' ? 'REVERSED' as const : printed > 0 ? 'COPY' as const : undefined;
    const school = await this.db.selectFrom('school_profile').select(['name', 'address', 'phone', 'email', 'motto']).executeTakeFirst();
    const buf = await this.pdf.render('receipt', {
      school: school ?? null,
      receiptNo: p.receiptNo, receivedAt: p.receivedAt, studentCode: p.studentCode, studentName: p.studentName, payerName: p.payerName,
      amountPesewas: p.amountPesewas, amountText: formatCedis(p.amountPesewas), method: methodLabel(p.method), referenceNo: p.referenceNo,
      allocations: p.allocations, creditCreatedPesewas: p.creditCreatedPesewas, balanceAfterPesewas: p.balanceAfterPesewas,
      recordedByName: p.recordedByName, reversal: p.reversal,
    }, watermark ? { watermark } : undefined);
    await this.audit.record({ action: 'export', entityType: 'payment_receipt', entityId: id, studentId: p.studentId, changes: { watermark: { after: watermark ?? 'ORIGINAL' } } }, user);
    return buf;
  }

  /** Earlier receipt prints, from the audit log when Agent D's audit table is in use. */
  private async previousPrints(paymentId: string): Promise<number> {
    try {
      const r = await sql<{ n: string }>`select count(*) as n from audit.events where entity_type = 'payment_receipt' and entity_id = ${paymentId} and action = 'export'`.execute(this.db);
      return Number(r.rows[0]?.n ?? 0);
    } catch (e) {
      this.logger.warn({ paymentId, err: e }, 'could not count earlier receipt prints');
      return 0;
    }
  }
}
