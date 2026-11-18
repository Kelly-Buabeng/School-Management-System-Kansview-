import { formatCedis, normaliseGhanaPhone, percentOf } from '@sms/shared';
import type { PaymentMethod } from '@/api/types';
import { applyPayment, balanceOf, currentEnrolment, getDb, summary, uid, type Db, type MPayment } from '../db';
import { audit, fakeFile, fakePdf, json, notFound, paginate, problem, r, validation } from '../http';
import { findStudent } from './students';

const METHODS: PaymentMethod[] = ['cash', 'bank_transfer', 'cheque', 'momo_mtn', 'telecel_cash', 'at_money'];
const today = () => new Date().toISOString().slice(0, 10);

function paymentDto(db: Db, p: MPayment) {
  const s = db.students.find((x) => x.id === p.studentId)!;
  const { idempotencyKey, recordedById, pendingReversal, ...rest } = p;
  void recordedById;
  return { ...rest, idempotencyKey, pendingReversal: pendingReversal ?? null, studentName: summary(db, s).fullName, studentCode: s.studentCode };
}

function invoiceDto(db: Db, i: Db['invoices'][number]) {
  const total = i.lines.reduce((a, l) => a + l.amountPesewas, 0);
  const paid = i.lines.reduce((a, l) => a + l.paidPesewas, 0);
  const term = db.terms.find((t) => t.id === i.termId);
  const year = db.years.find((y) => y.id === term?.academicYearId);
  return {
    id: i.id,
    invoiceNo: i.invoiceNo,
    studentId: i.studentId,
    studentName: summary(db, db.students.find((s) => s.id === i.studentId)!).fullName,
    termId: i.termId,
    termName: `${year?.name ?? ''} ${term?.name ?? ''}`.trim(),
    status: i.status,
    openingBalancePesewas: i.openingBalancePesewas,
    totalPesewas: total,
    paidPesewas: paid,
    adjustmentsPesewas: i.adjustmentsPesewas,
    outstandingPesewas: total - paid - i.adjustmentsPesewas,
    lines: i.lines.map((l) => ({ id: l.id, feeItemName: l.feeItemName, amountPesewas: l.amountPesewas, paidPesewas: l.paidPesewas })),
  };
}

function currentCashUp(db: Db) {
  return db.cashUps.find((c) => c.businessDate === today()) ?? null;
}

function recompute(db: Db, date: string) {
  const cu = db.cashUps.find((c) => c.businessDate === date);
  if (!cu || cu.status === 'closed') return;
  const pays = db.payments.filter((p) => p.receivedAt.slice(0, 10) === date && p.status === 'confirmed');
  cu.expected = {};
  for (const p of pays) cu.expected[p.method] = (cu.expected[p.method] ?? 0) + p.amountPesewas;
  cu.paymentCount = pays.length;
}

export const financeHandlers = [
  // ---------- fee setup ----------
  r.get('/fee-items', 'fee_structures:read', () => json({ data: getDb().feeItems })),
  r.post('/fee-items', 'fee_structures:create', async ({ user, body }) => {
    const b = await body<{ name?: string; category?: string; optional?: boolean }>();
    if (!b.name?.trim()) return validation([{ field: 'name', message: 'Enter a name' }]);
    const db = getDb();
    const item = { id: uid(), name: b.name.trim(), category: (b.category ?? 'other') as 'other', optional: Boolean(b.optional), priority: db.feeItems.length + 1, active: true };
    db.feeItems.push(item);
    audit(user, 'create', 'fee_item', `Added fee item ${item.name}`);
    return json(item, 201);
  }),
  r.get('/fee-structures', 'fee_structures:read', ({ query }) => {
    const termId = query.get('termId');
    return json({ data: getDb().feeStructures.filter((f) => !termId || f.termId === termId) });
  }),
  r.post('/fee-structures', 'fee_structures:create', async ({ user, body }) => {
    const db = getDb();
    const b = await body<{ termId?: string; levelId?: string; copyFromId?: string }>();
    const term = db.terms.find((t) => t.id === b.termId);
    const lvl = db.levels.find((l) => l.id === b.levelId);
    if (!term || !lvl) return validation([{ field: 'levelId', message: 'Choose a term and level' }]);
    if (db.feeStructures.some((f) => f.termId === term.id && f.levelId === lvl.id)) return problem(409, 'VALIDATION_FAILED', `${lvl.name} already has a fee structure for this term.`);
    const src = db.feeStructures.find((f) => f.id === b.copyFromId);
    const year = db.years.find((y) => y.id === term.academicYearId);
    const fs = { id: uid(), termId: term.id, termName: `${year?.name} ${term.name}`, levelId: lvl.id, levelName: lvl.name, status: 'draft' as const, lines: src ? src.lines.map((l) => ({ ...l })) : [], totalPesewas: src?.totalPesewas ?? 0 };
    db.feeStructures.push(fs);
    audit(user, 'create', 'fee_structure', `Created draft fee structure for ${lvl.name}`);
    return json(fs, 201);
  }),
  r.get<{ id: string }>('/fee-structures/{id}', 'fee_structures:read', ({ params }) => {
    const fs = getDb().feeStructures.find((f) => f.id === params.id);
    return fs ? json(fs) : notFound('fee structure');
  }),
  r.put<{ id: string }>('/fee-structures/{id}', 'fee_structures:update', async ({ user, params, body }) => {
    const db = getDb();
    const fs = db.feeStructures.find((f) => f.id === params.id);
    if (!fs) return notFound('fee structure');
    if (fs.status !== 'draft') return problem(422, 'FEE_STRUCTURE_IMMUTABLE', 'This fee structure is already active and cannot be changed. Create a new one for the next term.');
    const b = await body<{ lines?: { feeItemId: string; amountPesewas: number }[] }>();
    for (const l of b.lines ?? []) if (!Number.isSafeInteger(l.amountPesewas) || l.amountPesewas < 0) return validation([{ field: 'lines', message: 'Amounts must be whole pesewas' }]);
    fs.lines = (b.lines ?? []).map((l) => ({ ...l, feeItemName: db.feeItems.find((f) => f.id === l.feeItemId)?.name }));
    fs.totalPesewas = fs.lines.reduce((a, l) => a + l.amountPesewas, 0);
    audit(user, 'update', 'fee_structure', `Edited fee structure for ${fs.levelName}`);
    return json(fs);
  }),
  r.post<{ id: string }>('/fee-structures/{id}/activate', 'fee_structures:activate', ({ user, params }) => {
    const fs = getDb().feeStructures.find((f) => f.id === params.id);
    if (!fs) return notFound('fee structure');
    if (fs.status !== 'draft') return problem(422, 'FEE_STRUCTURE_NOT_ACTIVE', 'Only a draft can be activated.');
    fs.status = 'active';
    audit(user, 'approve', 'fee_structure', `Activated fee structure for ${fs.levelName}`);
    return json(fs);
  }),

  // ---------- invoices ----------
  r.post(
    '/invoices/generate',
    'invoices:create',
    async ({ user, body }) => {
      const db = getDb();
      const b = await body<{ termId?: string; scope?: { type?: string; ids?: string[] }; dryRun?: boolean; dueDate?: string }>();
      const term = db.terms.find((t) => t.id === b.termId);
      if (!term) return validation([{ field: 'termId', message: 'Choose a term' }]);
      const type = b.scope?.type ?? 'school';
      const ids = new Set(b.scope?.ids ?? []);
      const students = db.students.filter((s) => {
        if (s.archived || s.status !== 'active') return false;
        const en = currentEnrolment(db, s.id);
        const cls = db.classes.find((c) => c.id === en?.classId);
        if (type === 'student') return ids.has(s.id);
        if (type === 'class') return Boolean(cls && ids.has(cls.id));
        if (type === 'level') return Boolean(cls && ids.has(cls.levelId));
        return true;
      });
      const problems: { studentId?: string; studentName?: string; message: string }[] = [];
      const todo: { s: (typeof students)[number]; total: number; bf: number; fsLines: { feeItemId: string; feeItemName?: string; amountPesewas: number }[] }[] = [];
      let skipped = 0;
      for (const s of students) {
        const name = summary(db, s).fullName;
        if (db.invoices.some((i) => i.studentId === s.id && i.termId === term.id && i.status === 'issued')) {
          skipped += 1;
          continue;
        }
        const cls = db.classes.find((c) => c.id === currentEnrolment(db, s.id)?.classId);
        const fs = db.feeStructures.find((f) => f.termId === term.id && f.levelId === cls?.levelId && f.status === 'active');
        if (!fs) {
          problems.push({ studentId: s.id, studentName: name, message: `No active fee structure for ${cls?.name ?? 'this class'} in this term` });
          continue;
        }
        const lines = fs.lines.filter((l) => !db.feeItems.find((f) => f.id === l.feeItemId)?.optional);
        todo.push({ s, total: lines.reduce((a, l) => a + l.amountPesewas, 0), bf: balanceOf(db, s.id), fsLines: lines });
      }
      const preview = {
        dryRun: b.dryRun !== false,
        studentCount: todo.length,
        totalPesewas: todo.reduce((a, t) => a + t.total, 0),
        skippedAlreadyInvoiced: skipped,
        problems,
        sample: todo.slice(0, 8).map((t) => ({ studentName: summary(db, t.s).fullName, className: summary(db, t.s).className ?? '', totalPesewas: t.total, broughtForwardPesewas: t.bf })),
      };
      if (b.dryRun !== false) return json(preview);
      for (const t of todo) {
        db.counters.invoice += 1;
        const inv = { id: uid(), invoiceNo: `INV-${String(db.counters.invoice).padStart(6, '0')}`, studentId: t.s.id, termId: term.id, status: 'issued' as const, issueDate: today(), openingBalancePesewas: t.bf, adjustmentsPesewas: 0, lines: t.fsLines.map((l) => ({ id: uid(), feeItemId: l.feeItemId, feeItemName: l.feeItemName ?? '', priority: db.feeItems.find((f) => f.id === l.feeItemId)?.priority ?? 9, amountPesewas: l.amountPesewas, paidPesewas: 0 })) };
        db.invoices.push(inv);
        for (const l of inv.lines) db.ledger.push({ id: uid(), studentId: t.s.id, postedAt: new Date().toISOString(), entryType: 'charge', description: `${l.feeItemName} — ${term.name}`, reference: inv.invoiceNo, amountPesewas: l.amountPesewas });
      }
      audit(user, 'create', 'invoice', `Generated ${todo.length} invoices for ${term.name}`);
      return json({ ...preview, dryRun: false, jobId: uid() }, 202);
    },
    { idempotent: true },
  ),
  r.get('/invoices', 'invoices:read', ({ query }) => {
    const db = getDb();
    const studentId = query.get('studentId');
    const termId = query.get('termId');
    const list = db.invoices.filter((i) => (!studentId || i.studentId === studentId) && (!termId || i.termId === termId));
    return json(paginate(list.map((i) => invoiceDto(db, i)), query));
  }),
  r.get<{ id: string }>('/invoices/{id}', 'invoices:read', ({ params }) => {
    const db = getDb();
    const i = db.invoices.find((x) => x.id === params.id);
    return i ? json(invoiceDto(db, i)) : notFound('invoice');
  }),
  r.get<{ id: string }>('/invoices/{id}/pdf', 'invoices:export', ({ params }) => {
    const db = getDb();
    const i = db.invoices.find((x) => x.id === params.id);
    if (!i) return notFound('invoice');
    const d = invoiceDto(db, i);
    return fakePdf(`Invoice ${d.invoiceNo}`, [`Student: ${d.studentName}`, `Term: ${d.termName}`, ...d.lines.map((l) => `${l.feeItemName}: ${formatCedis(l.amountPesewas)}`), `Total: ${formatCedis(d.totalPesewas)}`, `Balance brought forward: ${formatCedis(d.openingBalancePesewas ?? 0)}`]);
  }),

  // ---------- payments ----------
  r.get('/payments/duplicate-check', 'payments:create', ({ query }) => {
    const db = getDb();
    const method = query.get('method');
    const ref = (query.get('referenceNo') ?? '').trim().toLowerCase();
    if (!ref) return json({ data: [] });
    const matches = db.payments
      .filter((p) => p.method === method && (p.referenceNo ?? '').toLowerCase() === ref)
      .map((p) => {
        const s = db.students.find((x) => x.id === p.studentId)!;
        return { paymentId: p.id, receiptNo: p.receiptNo, studentName: summary(db, s).fullName, studentCode: s.studentCode, amountPesewas: p.amountPesewas, receivedAt: p.receivedAt };
      });
    return json({ data: matches });
  }),
  r.get('/payments', 'payments:read', ({ query }) => {
    const db = getDb();
    const key = query.get('idempotencyKey');
    const studentId = query.get('studentId');
    const method = query.get('method');
    const from = query.get('from');
    const to = query.get('to');
    let list = [...db.payments].reverse();
    if (key) list = list.filter((p) => p.idempotencyKey === key);
    if (studentId) list = list.filter((p) => p.studentId === studentId);
    if (method) list = list.filter((p) => p.method === method);
    if (from) list = list.filter((p) => p.receivedAt.slice(0, 10) >= from);
    if (to) list = list.filter((p) => p.receivedAt.slice(0, 10) <= to);
    return json(paginate(list.map((p) => paymentDto(db, p)), query));
  }),
  r.post(
    '/payments',
    'payments:create',
    async ({ user, request, body }) => {
      const db = getDb();
      const b = await body<{
        studentId?: string;
        amountPesewas?: number;
        method?: PaymentMethod;
        referenceNo?: string;
        receivedAt?: string;
        payerName?: string;
        payerGuardianId?: string;
        notes?: string;
        allocations?: { invoiceLineId: string; amountPesewas: number }[];
        confirmDuplicate?: boolean;
        duplicateOverrideReason?: string;
      }>();
      const errors: { field: string; message: string }[] = [];
      const s = b.studentId ? findStudent(db, user, b.studentId) : null;
      if (!s) errors.push({ field: 'studentId', message: 'Choose the student' });
      if (!Number.isSafeInteger(b.amountPesewas) || (b.amountPesewas ?? 0) < 1) errors.push({ field: 'amountPesewas', message: 'Enter an amount greater than zero' });
      if (!b.method || !METHODS.includes(b.method)) errors.push({ field: 'method', message: 'Choose how it was paid' });
      if (!b.receivedAt) errors.push({ field: 'receivedAt', message: 'Enter the date received' });
      if (errors.length) return validation(errors);
      if (b.method !== 'cash' && !b.referenceNo?.trim()) {
        return problem(422, 'PAYMENT_REFERENCE_REQUIRED', 'Enter the reference number for this payment.', { errors: [{ field: 'referenceNo', code: 'REQUIRED', message: 'Required for everything except cash' }] });
      }
      if (b.allocations?.length) {
        const sum = b.allocations.reduce((a, x) => a + x.amountPesewas, 0);
        if (sum > b.amountPesewas!) return problem(422, 'PAYMENT_ALLOCATION_EXCEEDS_AMOUNT', 'The allocations add up to more than the amount paid.');
      }
      const cu = currentCashUp(db);
      if (cu?.status === 'closed' && b.receivedAt!.slice(0, 10) === today()) return problem(422, 'CASH_UP_CLOSED', "Today's cash-up is already closed. Payments now go on tomorrow's cash-up — ask the administrator.");
      const ref = b.referenceNo?.trim();
      if (ref) {
        const existing = db.payments.find((p) => p.method === b.method && (p.referenceNo ?? '').toLowerCase() === ref.toLowerCase());
        if (existing && !b.confirmDuplicate) {
          const es = db.students.find((x) => x.id === existing.studentId)!;
          return problem(409, 'PAYMENT_DUPLICATE_REFERENCE', 'This reference number was already recorded', {
            detail: `Reference ${ref} was recorded on receipt ${existing.receiptNo} on ${existing.receivedAt.slice(0, 10)} for ${es.studentCode}.`,
            errors: [{ field: 'referenceNo', code: 'DUPLICATE', message: `Already used on receipt ${existing.receiptNo}` }],
            meta: { existingPaymentId: existing.id, receiptNo: existing.receiptNo, canOverride: true },
          });
        }
        if (existing && (b.duplicateOverrideReason ?? '').trim().length < 5) return validation([{ field: 'duplicateOverrideReason', message: 'Explain why this is a separate payment (at least 5 characters)' }]);
      }
      const p = applyPayment(db, {
        studentId: s!.id,
        amountPesewas: b.amountPesewas!,
        method: b.method!,
        referenceNo: ref,
        receivedAt: b.receivedAt!,
        recordedBy: user.fullName,
        recordedById: user.id,
        payerName: b.payerName,
        payerGuardianId: b.payerGuardianId,
        notes: b.notes,
        allocations: b.allocations,
        idempotencyKey: request.headers.get('Idempotency-Key') ?? undefined,
      });
      recompute(db, b.receivedAt!.slice(0, 10));
      audit(user, 'create', 'payment', `Recorded ${formatCedis(p.amountPesewas)} for ${s!.studentCode}, receipt ${p.receiptNo}${b.confirmDuplicate ? ` (duplicate reference overridden: ${b.duplicateOverrideReason})` : ''}`, p.id);
      return json(paymentDto(db, p), 201);
    },
    { idempotent: true },
  ),
  r.get<{ id: string }>('/payments/{id}', 'payments:read', ({ params }) => {
    const db = getDb();
    const p = db.payments.find((x) => x.id === params.id);
    return p ? json(paymentDto(db, p)) : notFound('payment');
  }),
  r.put<{ id: string }>('/payments/{id}/attachment', 'payments:create', async ({ user, params, request }) => {
    const db = getDb();
    const p = db.payments.find((x) => x.id === params.id);
    if (!p) return notFound('payment');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return validation([{ field: 'file', message: 'Choose a file' }]);
    if (file.size > 5 * 1024 * 1024) return problem(413, 'FILE_TOO_LARGE', 'That file is bigger than 5 MB.');
    p.hasAttachment = true;
    audit(user, 'update', 'payment', `Attached evidence to ${p.receiptNo}`, p.id);
    return json(paymentDto(db, p));
  }),
  r.post<{ id: string }>(
    '/payments/{id}/reverse',
    'payments:reverse',
    async ({ user, params, body }) => {
      const db = getDb();
      const p = db.payments.find((x) => x.id === params.id);
      if (!p) return notFound('payment');
      if (p.status === 'reversed') return problem(409, 'PAYMENT_ALREADY_REVERSED', 'This payment was already reversed.');
      const { reason } = await body<{ reason?: string }>();
      if ((reason ?? '').trim().length < 5) return validation([{ field: 'reason', message: 'Give a reason (at least 5 characters)' }]);
      const cu = db.cashUps.find((c) => c.businessDate === p.receivedAt.slice(0, 10));
      if (!cu || cu.status === 'closed') {
        p.pendingReversal = { requestedBy: user.fullName, reason: reason!, at: new Date().toISOString() };
        audit(user, 'reverse', 'payment', `Requested reversal of ${p.receiptNo} (needs administrator approval): ${reason}`, p.id);
        return json({ ...paymentDto(db, p), awaitingApproval: true }, 202);
      }
      reverse(db, p, user.fullName, reason!);
      recompute(db, p.receivedAt.slice(0, 10));
      audit(user, 'reverse', 'payment', `Reversed ${p.receiptNo}: ${reason}`, p.id);
      return json(paymentDto(db, p));
    },
    { idempotent: true },
  ),
  r.post<{ id: string }>('/payments/{id}/reverse/approve', 'payments:reverse_approve', ({ user, params }) => {
    const db = getDb();
    const p = db.payments.find((x) => x.id === params.id);
    if (!p?.pendingReversal) return notFound('pending reversal');
    if (p.pendingReversal.requestedBy === user.fullName) return problem(403, 'ADJUSTMENT_SELF_APPROVAL', 'Someone else must approve a reversal you requested.');
    reverse(db, p, user.fullName, p.pendingReversal.reason);
    audit(user, 'approve', 'payment', `Approved reversal of ${p.receiptNo}`, p.id);
    return json(paymentDto(db, p));
  }),
  r.get<{ id: string }>('/payments/{id}/receipt.pdf', 'payments:read', ({ user, params }) => {
    const db = getDb();
    const p = db.payments.find((x) => x.id === params.id);
    if (!p) return notFound('payment');
    const d = paymentDto(db, p);
    audit(user, 'export', 'payment', `Printed receipt ${p.receiptNo}`, p.id);
    return fakePdf(`${db.school.name} — Receipt ${p.receiptNo}${p.status === 'reversed' ? ' (REVERSED)' : ''}`, [
      `Student: ${d.studentName} (${d.studentCode})`,
      `Amount: ${formatCedis(p.amountPesewas)}`,
      `Method: ${p.method}${p.referenceNo ? `  Ref: ${p.referenceNo}` : ''}`,
      `Received: ${p.receivedAt.slice(0, 16).replace('T', ' ')}`,
      ...p.allocations.map((a) => `  ${a.feeItemName}: ${formatCedis(a.amountPesewas)}`),
      `Balance after payment: ${formatCedis(p.balanceAfterPesewas)}`,
      `Recorded by: ${p.recordedBy}`,
    ]);
  }),

  // ---------- adjustments ----------
  r.get('/adjustments', 'adjustments:read', ({ query }) => {
    const status = query.get('status');
    return json({ data: getDb().adjustments.filter((a) => !status || a.status === status).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) });
  }),
  r.post(
    '/adjustments',
    'adjustments:create',
    async ({ user, body }) => {
      const db = getDb();
      const b = await body<{ studentId?: string; termId?: string; type?: string; amountPesewas?: number; percentBasisPoints?: number; reason?: string }>();
      const s = b.studentId ? findStudent(db, user, b.studentId) : null;
      const errors: { field: string; message: string }[] = [];
      if (!s) errors.push({ field: 'studentId', message: 'Choose the student' });
      if (!b.type) errors.push({ field: 'type', message: 'Choose the type' });
      if (!b.amountPesewas && !b.percentBasisPoints) errors.push({ field: 'amountPesewas', message: 'Enter an amount or a percentage' });
      if ((b.reason ?? '').trim().length < 5) errors.push({ field: 'reason', message: 'Give a reason (at least 5 characters)' });
      if (errors.length) return validation(errors);
      const adj = { id: uid(), studentId: s!.id, studentName: summary(db, s!).fullName, termId: b.termId ?? db.terms.find((t) => t.isCurrent)!.id, type: b.type as 'discount', amountPesewas: b.amountPesewas, percentBasisPoints: b.percentBasisPoints, reason: b.reason!, status: 'pending' as const, requestedBy: user.fullName, requestedById: user.id, requestedAt: new Date().toISOString() };
      db.adjustments.unshift(adj);
      audit(user, 'create', 'adjustment', `Requested ${adj.type} for ${adj.studentName}`, adj.id);
      return json(adj, 201);
    },
    { idempotent: true },
  ),
  r.post<{ id: string }>('/adjustments/{id}/approve', 'adjustments:approve', ({ user, params }) => {
    const db = getDb();
    const a = db.adjustments.find((x) => x.id === params.id);
    if (!a) return notFound('adjustment');
    if (a.requestedById === user.id) return problem(403, 'ADJUSTMENT_SELF_APPROVAL', 'You cannot approve your own request. Another approver must do it.');
    if (a.status !== 'pending') return problem(409, 'ADJUSTMENT_INVALID_STATE', 'This request was already decided.');
    const inv = db.invoices.find((i) => i.studentId === a.studentId && i.termId === a.termId && i.status === 'issued');
    const base = inv ? inv.lines.reduce((s, l) => s + l.amountPesewas, 0) : 0;
    const amount = a.amountPesewas ?? percentOf(base, a.percentBasisPoints ?? 0);
    const sign = a.type === 'manual_charge' ? 1 : -1;
    db.ledger.push({ id: uid(), studentId: a.studentId, postedAt: new Date().toISOString(), entryType: a.type === 'manual_charge' ? 'charge' : 'discount', description: `${a.type.replace('_', ' ')} — ${a.reason}`, amountPesewas: sign * amount });
    if (inv && sign < 0) inv.adjustmentsPesewas += amount;
    a.status = 'approved';
    a.decidedBy = user.fullName;
    a.decidedAt = new Date().toISOString();
    audit(user, 'approve', 'adjustment', `Approved ${a.type} of ${formatCedis(amount)} for ${a.studentName}`, a.id);
    return json(a);
  }),
  r.post<{ id: string }>('/adjustments/{id}/reject', 'adjustments:approve', ({ user, params }) => {
    const a = getDb().adjustments.find((x) => x.id === params.id);
    if (!a) return notFound('adjustment');
    if (a.status !== 'pending') return problem(409, 'ADJUSTMENT_INVALID_STATE', 'This request was already decided.');
    a.status = 'rejected';
    a.decidedBy = user.fullName;
    a.decidedAt = new Date().toISOString();
    audit(user, 'update', 'adjustment', `Rejected ${a.type} for ${a.studentName}`, a.id);
    return json(a);
  }),

  // ---------- balances & ledger ----------
  r.get<{ id: string }>('/students/{id}/ledger', 'balances:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    let running = 0;
    const entries = db.ledger
      .filter((l) => l.studentId === params.id)
      .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
      .map((l) => {
        running += l.amountPesewas;
        return { id: l.id, postedAt: l.postedAt, entryType: l.entryType, description: l.description, reference: l.reference, debitPesewas: Math.max(0, l.amountPesewas), creditPesewas: Math.max(0, -l.amountPesewas), runningBalancePesewas: running };
      });
    return json({ studentId: params.id, entries, balancePesewas: running });
  }),
  r.get<{ id: string }>('/students/{id}/balance', 'balances:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    const bal = balanceOf(db, params.id);
    const last = db.payments.filter((p) => p.studentId === params.id && p.status === 'confirmed').at(-1);
    const arrears = db.ledger.filter((l) => l.studentId === params.id && l.entryType === 'opening_balance').reduce((a, l) => a + l.amountPesewas, 0);
    return json({ studentId: params.id, balancePesewas: bal, currentTermOutstandingPesewas: Math.max(0, bal - Math.max(0, arrears)), arrearsPesewas: Math.min(Math.max(0, arrears), Math.max(0, bal)), creditPesewas: Math.max(0, -bal), lastPaymentAt: last?.receivedAt ?? null });
  }),
  r.get<{ id: string }>('/students/{id}/statement.pdf', 'balances:export', ({ user, params }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    audit(user, 'export', 'student', `Printed fee statement for ${s.studentCode}`, s.id);
    return fakePdf(`Fee statement — ${s.firstName} ${s.lastName}`, db.ledger.filter((l) => l.studentId === s.id).map((l) => `${l.postedAt.slice(0, 10)}  ${l.description}  ${formatCedis(l.amountPesewas)}`).concat([`Balance: ${formatCedis(balanceOf(db, s.id))}`]));
  }),
  r.get<{ guardianId: string }>('/guardians/{guardianId}/statement.pdf', 'balances:export', ({ params }) => {
    const db = getDb();
    const g = db.guardians.find((x) => x.id === params.guardianId);
    if (!g) return notFound('parent or guardian');
    const kids = db.links.filter((l) => l.guardianId === g.id && l.isFeePayer).map((l) => db.students.find((s) => s.id === l.studentId)!);
    return fakePdf(`Family statement — ${g.firstName} ${g.lastName}`, kids.map((k) => `${k.firstName} ${k.lastName} (${k.studentCode}): ${formatCedis(balanceOf(db, k.id))}`));
  }),
  r.get('/balances/school', 'balances:read', () => {
    const db = getDb();
    const bal = db.students.map((s) => balanceOf(db, s.id));
    return json({ outstandingPesewas: bal.filter((b) => b > 0).reduce((a, b) => a + b, 0), creditPesewas: -bal.filter((b) => b < 0).reduce((a, b) => a + b, 0), studentsOwing: bal.filter((b) => b > 0).length });
  }),
  r.get('/balances/classes', 'balances:read', () => {
    const db = getDb();
    const cur = db.years.find((y) => y.isCurrent)!;
    return json({
      data: db.classes
        .filter((c) => c.academicYearId === cur.id)
        .map((c) => {
          const ids = db.enrolments.filter((e) => e.classId === c.id && !e.endDate).map((e) => e.studentId);
          const billed = db.ledger.filter((l) => ids.includes(l.studentId) && l.amountPesewas > 0).reduce((a, l) => a + l.amountPesewas, 0);
          const paid = -db.ledger.filter((l) => ids.includes(l.studentId) && l.amountPesewas < 0).reduce((a, l) => a + l.amountPesewas, 0);
          return { classId: c.id, className: c.name, billedPesewas: billed, paidPesewas: paid, outstandingPesewas: billed - paid };
        }),
    });
  }),

  // ---------- cash-up ----------
  r.get('/cash-ups', 'cash_up:read', () => {
    const db = getDb();
    db.cashUps.forEach((c) => recompute(db, c.businessDate));
    return json({ data: [...db.cashUps].sort((a, b) => b.businessDate.localeCompare(a.businessDate)) });
  }),
  r.post('/cash-ups', 'cash_up:create', ({ user }) => {
    const db = getDb();
    const existing = currentCashUp(db);
    if (existing) return json(existing, 200);
    const cu = { id: uid(), businessDate: today(), status: 'open' as const, expected: {}, paymentCount: 0 };
    db.cashUps.push(cu);
    recompute(db, cu.businessDate);
    audit(user, 'create', 'cash_up', `Opened cash-up for ${cu.businessDate}`);
    return json(cu, 201);
  }),
  r.get<{ id: string }>('/cash-ups/{id}', 'cash_up:read', ({ params }) => {
    const db = getDb();
    const cu = db.cashUps.find((c) => c.id === params.id);
    if (!cu) return notFound('cash-up');
    recompute(db, cu.businessDate);
    return json(cu);
  }),
  r.post<{ id: string }>('/cash-ups/{id}/close', 'cash_up:close', async ({ user, params, body }) => {
    const db = getDb();
    const cu = db.cashUps.find((c) => c.id === params.id);
    if (!cu) return notFound('cash-up');
    if (cu.status === 'closed') return problem(409, 'CASH_UP_CLOSED', 'This cash-up is already closed.');
    recompute(db, cu.businessDate);
    const b = await body<{ counted?: Record<string, number>; note?: string }>();
    const counted = b.counted ?? {};
    const expectedTotal = Object.values(cu.expected).reduce((a, v) => a + (v ?? 0), 0);
    const countedTotal = Object.values(counted).reduce((a, v) => a + (v ?? 0), 0);
    const variance = countedTotal - expectedTotal;
    if (variance !== 0 && (b.note ?? '').trim().length < 5) return validation([{ field: 'note', message: 'Explain the difference before closing' }]);
    Object.assign(cu, { status: 'closed', counted, variancePesewas: variance, note: b.note, closedBy: user.fullName });
    audit(user, 'update', 'cash_up', `Closed cash-up for ${cu.businessDate} (variance ${formatCedis(variance)})`);
    return json(cu);
  }),

  // ---------- reports ----------
  r.get('/reports/collections', 'finance_reports:read', ({ query }) => {
    const db = getDb();
    if (query.get('format') === 'xlsx') return fakeFile('collections.xlsx', 'mock spreadsheet');
    if (query.get('format') === 'pdf') return fakePdf('Collections report', ['Mock PDF export']);
    const groupBy = query.get('groupBy') ?? 'method';
    const from = query.get('from');
    const to = query.get('to');
    const pays = db.payments.filter((p) => p.status === 'confirmed' && (!from || p.receivedAt.slice(0, 10) >= from) && (!to || p.receivedAt.slice(0, 10) <= to));
    const groups = new Map<string, { count: number; total: number }>();
    for (const p of pays) {
      const key =
        groupBy === 'day' ? p.receivedAt.slice(0, 10) : groupBy === 'class' ? (summary(db, db.students.find((s) => s.id === p.studentId)!).className ?? '—') : groupBy === 'fee_item' ? 'All items' : p.method;
      const g = groups.get(key) ?? { count: 0, total: 0 };
      g.count += 1;
      g.total += p.amountPesewas;
      groups.set(key, g);
    }
    const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ group: k, count: v.count, totalPesewas: v.total }));
    return json({ columns: [{ key: 'group', label: groupBy === 'method' ? 'Method' : groupBy === 'day' ? 'Date' : 'Group' }, { key: 'count', label: 'Payments' }, { key: 'totalPesewas', label: 'Total', money: true }], rows, totals: { group: 'Total', count: pays.length, totalPesewas: pays.reduce((a, p) => a + p.amountPesewas, 0) } });
  }),
  r.get('/reports/defaulters', 'finance_reports:read', ({ query }) => {
    const db = getDb();
    if (query.get('format') === 'xlsx') return fakeFile('defaulters.xlsx', 'mock spreadsheet');
    if (query.get('format') === 'pdf') return fakePdf('Defaulters report', ['Mock PDF export']);
    const min = Number(query.get('minOutstandingPesewas') ?? 1);
    const rows = db.students
      .map((s) => ({ s, bal: balanceOf(db, s.id) }))
      .filter((x) => x.bal >= min)
      .sort((a, b) => b.bal - a.bal)
      .map(({ s, bal }) => {
        const g = db.guardians.find((x) => x.id === db.links.find((l) => l.studentId === s.id && l.isFeePayer)?.guardianId);
        return { student: summary(db, s).fullName, code: s.studentCode, className: summary(db, s).className ?? '', payer: g ? `${g.firstName} ${g.lastName}` : '', phone: g?.phonePrimary ?? '', outstandingPesewas: bal };
      });
    return json({ columns: [{ key: 'student', label: 'Student' }, { key: 'code', label: 'ID' }, { key: 'className', label: 'Class' }, { key: 'payer', label: 'Fee payer' }, { key: 'phone', label: 'Phone' }, { key: 'outstandingPesewas', label: 'Owes', money: true }], rows, totals: { student: `${rows.length} students`, outstandingPesewas: rows.reduce((a, r2) => a + (r2.outstandingPesewas as number), 0) } });
  }),
  r.get('/reports/aging', 'finance_reports:read', ({ query }) => {
    const db = getDb();
    if (query.get('format') && query.get('format') !== 'json') return fakePdf('Aging report', ['Mock export']);
    let current = 0;
    let older = 0;
    for (const s of db.students) {
      const bal = balanceOf(db, s.id);
      if (bal <= 0) continue;
      const ob = db.ledger.filter((l) => l.studentId === s.id && l.entryType === 'opening_balance').reduce((a, l) => a + l.amountPesewas, 0);
      older += Math.min(ob, bal);
      current += bal - Math.min(ob, bal);
    }
    return json({ columns: [{ key: 'bucket', label: 'Age' }, { key: 'amountPesewas', label: 'Outstanding', money: true }], rows: [{ bucket: 'Current term', amountPesewas: current }, { bucket: '1 term', amountPesewas: older }, { bucket: '2 terms', amountPesewas: 0 }, { bucket: '3+ terms', amountPesewas: 0 }] });
  }),
  r.get('/reports/daily-cash-up', 'finance_reports:read', ({ query }) => {
    const db = getDb();
    const date = query.get('date') ?? today();
    if (query.get('format') && query.get('format') !== 'json') return fakePdf(`Daily cash-up ${date}`, ['Mock export']);
    const pays = db.payments.filter((p) => p.receivedAt.slice(0, 10) === date);
    return json({ columns: [{ key: 'receiptNo', label: 'Receipt' }, { key: 'student', label: 'Student' }, { key: 'method', label: 'Method' }, { key: 'status', label: 'Status' }, { key: 'amountPesewas', label: 'Amount', money: true }], rows: pays.map((p) => ({ receiptNo: p.receiptNo, student: summary(db, db.students.find((s) => s.id === p.studentId)!).fullName, method: p.method, status: p.status, amountPesewas: p.amountPesewas })), totals: { receiptNo: 'Total', amountPesewas: pays.filter((p) => p.status === 'confirmed').reduce((a, p) => a + p.amountPesewas, 0) } });
  }),
  r.get('/reports/reconciliation', 'finance_reports:read', ({ query }) => {
    const db = getDb();
    if (query.get('format') && query.get('format') !== 'json') return fakePdf('Reconciliation', ['Mock export']);
    const nums = db.payments.map((p) => Number(p.receiptNo.slice(4))).sort((a, b) => a - b);
    const gaps = nums.filter((n, i) => i > 0 && n !== nums[i - 1]! + 1).length;
    return json({ columns: [{ key: 'check', label: 'Check' }, { key: 'result', label: 'Result' }], rows: [{ check: 'Receipt numbers', result: gaps === 0 ? `No gaps (RCP-000001 to RCP-${String(nums.at(-1) ?? 0).padStart(6, '0')})` : `${gaps} gap(s) found` }, { check: 'Reversals', result: String(db.payments.filter((p) => p.status === 'reversed').length) }] });
  }),
];

function reverse(db: Db, p: MPayment, by: string, reason: string) {
  db.counters.reversal += 1;
  const reversalNo = `REV-${String(db.counters.reversal).padStart(6, '0')}`;
  p.status = 'reversed';
  p.reversal = { reversedAt: new Date().toISOString(), reversedBy: by, reason, reversalNo };
  p.pendingReversal = null;
  for (const a of p.allocations) {
    const line = db.invoices.flatMap((i) => i.lines).find((l) => l.id === a.invoiceLineId);
    if (line) line.paidPesewas -= a.amountPesewas;
  }
  db.ledger.push({ id: uid(), studentId: p.studentId, postedAt: new Date().toISOString(), entryType: 'reversal', description: `Reversal of ${p.receiptNo}: ${reason}`, reference: reversalNo, amountPesewas: p.amountPesewas });
}

export { normaliseGhanaPhone };
