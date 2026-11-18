import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { todayInAccra } from '@sms/shared';
import { PaymentsService } from '../../src/modules/finance/payments.service';
import { SCOPE_SERVICE } from '../../src/security/scope.service';
import { activeStructure, addGuardian, addStudent, auditEvents, key, RANDOM_ID, seedSchool, setupC, type Ctx, type School } from './helpers';

const now = () => new Date().toISOString();

describe('CP3: fee structure → invoices → manual payment → receipt → balance', () => {
  let ctx: Ctx;
  let school: School;
  let s1: string; let s2: string; let s3: string; let p2Student: string;

  const pay = (studentId: string, amountPesewas: number, extra: Record<string, unknown> = {}, k = key()) =>
    ctx.http().post('/api/v1/payments').set('Idempotency-Key', k).send({ studentId, amountPesewas, method: 'cash', receivedAt: now(), payerName: 'Ama Mensah', ...extra });
  const balance = async (id: string) => (await ctx.http().get(`/api/v1/students/${id}/balance`).expect(200)).body.balancePesewas as number;

  beforeAll(async () => {
    ctx = await setupC();
    school = await seedSchool(ctx.k);
    s1 = await addStudent(ctx.k, school.classes.P1A, school.yearId);
    s2 = await addStudent(ctx.k, school.classes.P1A, school.yearId);
    s3 = await addStudent(ctx.k, school.classes.P1A, school.yearId);
    p2Student = await addStudent(ctx.k, school.classes.P2A, school.yearId);
  });
  afterAll(async () => ctx?.close());

  it('fee structure: draft is editable, BURSAR cannot activate, active is immutable', async () => {
    ctx.as('BURSAR');
    await ctx.http().post('/api/v1/fee-items').send({ code: 'tuition', name: 'Dup', category: 'tuition' }).expect(409);
    const d = await ctx.http().post('/api/v1/fee-structures').send({ termId: school.termIds[0], levelId: school.levels.P1, name: 'P1 Term 1', lines: [{ feeItemId: school.feeItems.tuition, amountPesewas: 1 }] }).expect(201);
    expect(d.body.status).toBe('draft');
    const put = await ctx.http().put(`/api/v1/fee-structures/${d.body.id}`).send({
      lines: [
        { feeItemId: school.feeItems.tuition, amountPesewas: 100_000 },
        { feeItemId: school.feeItems.pta, amountPesewas: 5_000 },
        { feeItemId: school.feeItems.feeding, amountPesewas: 20_000 },
        { feeItemId: school.feeItems.bus, amountPesewas: 30_000 },
      ],
    }).expect(200);
    expect(put.body.compulsoryTotalPesewas).toBe(125_000);
    expect(put.body.lines.find((l: { feeItemId: string }) => l.feeItemId === school.feeItems.bus).isOptional).toBe(true);
    await ctx.http().post(`/api/v1/fee-structures/${d.body.id}/activate`).expect(403);
    ctx.as('ADMIN');
    await ctx.http().post(`/api/v1/fee-structures/${d.body.id}/activate`).expect(200);
    ctx.as('BURSAR');
    const r = await ctx.http().put(`/api/v1/fee-structures/${d.body.id}`).send({ lines: [] }).expect(422);
    expect(r.body.code).toBe('FEE_STRUCTURE_IMMUTABLE');
    // optional bus for s3
    await ctx.http().put(`/api/v1/students/${s3}/optional-items`).send({ termId: school.termIds[0], items: [{ feeItemId: school.feeItems.bus, optedIn: true }] }).expect(200);
    // copy to term 2 as a draft
    const copy = await ctx.http().post('/api/v1/fee-structures').send({ termId: school.termIds[1], levelId: school.levels.P1, name: 'P1 Term 2', copyFromStructureId: d.body.id }).expect(201);
    expect(copy.body.lines).toHaveLength(4);
    expect(copy.body.status).toBe('draft');
  });

  it('invoice generation: dry run preview with problems, then idempotent real run', async () => {
    ctx.as('BURSAR');
    const body = { termId: school.termIds[0], scope: { type: 'school' }, dryRun: true };
    const dry = await ctx.http().post('/api/v1/invoices/generate').send(body).expect(200);
    expect(dry.body.counts).toEqual({ candidates: 4, toInvoice: 3, alreadyInvoiced: 0, problems: 1 });
    expect(dry.body.problems[0]).toMatchObject({ studentId: p2Student, code: 'NO_ACTIVE_STRUCTURE' });
    expect(dry.body.totalPesewas).toBe(125_000 * 3 + 30_000);
    expect(await ctx.k.selectFrom('invoices').select('id').execute()).toHaveLength(0);

    await ctx.http().post('/api/v1/invoices/generate').send({ ...body, dryRun: false }).expect(400);
    const k1 = key();
    const real = await ctx.http().post('/api/v1/invoices/generate').set('Idempotency-Key', k1).send({ ...body, dryRun: false }).expect(201);
    expect(real.body.invoices).toHaveLength(3);
    expect(real.body.invoices.map((i: { invoiceNo: string }) => i.invoiceNo).sort()).toEqual(['INV-000001', 'INV-000002', 'INV-000003']);
    const again = await ctx.http().post('/api/v1/invoices/generate').set('Idempotency-Key', key()).send({ ...body, dryRun: false }).expect(201);
    expect(again.body.invoices).toHaveLength(0);
    expect(again.body.counts.alreadyInvoiced).toBe(3);
    expect(await balance(s1)).toBe(125_000);
    expect(await balance(s3)).toBe(155_000);
    const inv = (await ctx.http().get(`/api/v1/invoices?studentId=${s1}`).expect(200)).body.data[0];
    const full = (await ctx.http().get(`/api/v1/invoices/${inv.id}`).expect(200)).body;
    expect(full.lines.map((l: { feeItemName: string }) => l.feeItemName)).toEqual(['Tuition', 'PTA levy', 'Feeding']);
    expect(full.openingBalancePesewas).toBe(0);
  });

  it('partial MoMo payment: receipt, oldest-first allocation, balance, audit', async () => {
    ctx.as('BURSAR');
    const r = await pay(s1, 50_000, { method: 'momo_mtn', referenceNo: ' 61 234 567 890 ' }).expect(201);
    expect(r.body).toMatchObject({ receiptNo: 'RCP-000001', status: 'confirmed', source: 'manual', externalReference: null, referenceNo: '61234567890', creditCreatedPesewas: 0, balanceAfterPesewas: 75_000 });
    expect(r.body.allocations).toEqual([expect.objectContaining({ feeItemName: 'Tuition', amountPesewas: 50_000 })]);
    expect(await balance(s1)).toBe(75_000);
    const b = (await ctx.http().get(`/api/v1/students/${s1}/balance`).expect(200)).body;
    expect(b).toMatchObject({ currentTermOutstandingPesewas: 75_000, arrearsPesewas: 0, creditPesewas: 0 });
    expect((await auditEvents(ctx)).some((e) => e.action === 'create' && e.entityType === 'payment' && e.entityId === r.body.id)).toBe(true);
    const led = (await ctx.http().get(`/api/v1/students/${s1}/ledger`).expect(200)).body;
    expect(led.entries.at(-1)).toMatchObject({ entryType: 'payment', amountPesewas: -50_000, runningBalancePesewas: 75_000 });
  });

  it('reference is required for every method except cash', async () => {
    ctx.as('BURSAR');
    const r = await pay(s1, 1000, { method: 'momo_mtn' }).expect(422);
    expect(r.body.code).toBe('PAYMENT_REFERENCE_REQUIRED');
  });

  it('duplicate reference warning, then audited override', async () => {
    ctx.as('BURSAR');
    const dc = await ctx.http().get('/api/v1/payments/duplicate-check').query({ method: 'momo_mtn', referenceNo: '61234567890' }).expect(200);
    expect(dc.body.data).toHaveLength(1);
    const first = await pay(s2, 10_000, { method: 'momo_mtn', referenceNo: '61234 567890' }).expect(409);
    expect(first.body.code).toBe('PAYMENT_DUPLICATE_REFERENCE');
    expect(first.body.meta).toMatchObject({ receiptNo: 'RCP-000001', canOverride: true });
    expect(first.body.meta.existingPaymentId).toBeTruthy();
    await pay(s2, 10_000, { method: 'momo_mtn', referenceNo: '61234567890', confirmDuplicate: true }).expect(400);
    const ok = await pay(s2, 10_000, { method: 'momo_mtn', referenceNo: '61234567890', confirmDuplicate: true, duplicateOverrideReason: 'Parent paid two children with one MoMo transfer' }).expect(201);
    expect(ok.body.duplicateOverrideReason).toContain('two children');
    const ev = (await auditEvents(ctx)).find((e) => e.entityId === ok.body.id);
    expect(ev?.reason).toContain('Duplicate reference override');
  });

  it('idempotent replay returns the same receipt; a different body with the same key is refused', async () => {
    ctx.as('BURSAR');
    const k1 = key();
    const at = { receivedAt: now() };
    const a = await pay(s2, 5_000, at, k1).expect(201);
    const b = await pay(s2, 5_000, at, k1).expect(201);
    expect(b.body.receiptNo).toBe(a.body.receiptNo);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const c = await pay(s2, 6_000, at, k1).expect(422);
    expect(c.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await ctx.k.selectFrom('payments').select('id').where('idempotency_key', '=', k1).execute())).toHaveLength(1);
    const list = await ctx.http().get('/api/v1/payments').query({ idempotencyKey: k1 }).expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('overpayment becomes credit that the next term invoice consumes (brought forward snapshot)', async () => {
    ctx.as('BURSAR');
    const r = await pay(s3, 200_000).expect(201);
    expect(r.body.creditCreatedPesewas).toBe(45_000);
    expect(r.body.balanceAfterPesewas).toBe(-45_000);
    expect((await ctx.http().get(`/api/v1/students/${s3}/balance`).expect(200)).body.creditPesewas).toBe(45_000);
    await activeStructure(ctx, school.termIds[1]!, school.levels.P1, [{ feeItemId: school.feeItems.tuition, amountPesewas: 110_000 }]);
    ctx.as('BURSAR');
    const g = await ctx.http().post('/api/v1/invoices/generate').set('Idempotency-Key', key()).send({ termId: school.termIds[1], scope: { type: 'student', ids: [s3] }, dryRun: false }).expect(201);
    expect(g.body.invoices[0]).toMatchObject({ openingBalancePesewas: -45_000, creditAppliedPesewas: 45_000, totalPesewas: 110_000 });
    expect(await balance(s3)).toBe(65_000);
    const inv = (await ctx.http().get(`/api/v1/invoices/${g.body.invoices[0].invoiceId}`).expect(200)).body;
    expect(inv).toMatchObject({ paidPesewas: 45_000, outstandingPesewas: 65_000 });
    const pv = (await ctx.http().get(`/api/v1/payments/${r.body.id}`).expect(200)).body;
    expect(pv.creditCreatedPesewas).toBe(0);
  });

  it('void is blocked while payments are allocated', async () => {
    ctx.as('BURSAR');
    const inv = (await ctx.http().get(`/api/v1/invoices?studentId=${s1}`).expect(200)).body.data[0];
    const r = await ctx.http().post(`/api/v1/invoices/${inv.id}/void`).send({ reason: 'Wrong class billed' }).expect(422);
    expect(r.body.code).toBe('INVOICE_HAS_PAYMENTS');
  });

  it('same-day reversal by the bursar restores the balance; cannot reverse twice', async () => {
    ctx.as('BURSAR');
    const before = await balance(s2);
    const p = await pay(s2, 7_000).expect(201);
    expect(await balance(s2)).toBe(before - 7_000);
    await ctx.http().post(`/api/v1/payments/${p.body.id}/reverse`).send({ reason: 'Entered twice' }).expect(400);
    const r = await ctx.http().post(`/api/v1/payments/${p.body.id}/reverse`).set('Idempotency-Key', key()).send({ reason: 'Entered twice' }).expect(200);
    expect(r.body.status).toBe('reversed');
    expect(r.body.reversal).toMatchObject({ reversalNo: 'REV-000001', status: 'approved', reason: 'Entered twice' });
    expect(r.body.allocations).toEqual([]);
    expect(await balance(s2)).toBe(before);
    const again = await ctx.http().post(`/api/v1/payments/${p.body.id}/reverse`).set('Idempotency-Key', key()).send({ reason: 'Entered twice' }).expect(409);
    expect(again.body.code).toBe('PAYMENT_ALREADY_REVERSED');
    const led = (await ctx.http().get(`/api/v1/students/${s2}/ledger`).expect(200)).body.entries;
    const rev = led.find((e: { entryType: string; paymentId: string }) => e.entryType === 'reversal' && e.paymentId === p.body.id);
    expect(rev.amountPesewas).toBe(7_000);
    expect(rev.reversesEntryId).toBeTruthy();
  });

  it('after cash-up close a reversal needs ADMIN approval (requester cannot approve)', async () => {
    ctx.as('BURSAR');
    const cu = await ctx.http().post('/api/v1/cash-ups').send({}).expect(201);
    expect(cu.body.businessDate).toBe(todayInAccra());
    const before = await balance(s1);
    const p = await pay(s1, 3_000).expect(201);
    expect(p.body.cashUpId).toBe(cu.body.id);
    const closed = await ctx.http().post(`/api/v1/cash-ups/${cu.body.id}/close`).send({ countedByMethod: { cash: 0 } }).expect(200);
    expect(closed.body.status).toBe('closed');
    const r = await ctx.http().post(`/api/v1/payments/${p.body.id}/reverse`).set('Idempotency-Key', key()).send({ reason: 'Wrong student' }).expect(202);
    expect(r.body.status).toBe('confirmed');
    expect(r.body.reversal.status).toBe('pending');
    await ctx.http().post(`/api/v1/payments/${p.body.id}/reverse/approve`).expect(403);
    ctx.as('ADMIN');
    const ok = await ctx.http().post(`/api/v1/payments/${p.body.id}/reverse/approve`).expect(200);
    expect(ok.body.status).toBe('reversed');
    expect(ok.body.reversal.reversalNo).toBe('REV-000002');
    ctx.as('BURSAR');
    expect(await balance(s1)).toBe(before);
    await ctx.k.updateTable('cash_ups').set({ business_date: '2026-01-01' }).where('id', '=', cu.body.id).execute(); // free today's slot for later tests
  });

  it('receipt PDF goes through PDF_SERVICE (stub returns 501 until Agent F lands)', async () => {
    ctx.as('BURSAR');
    const p = (await ctx.http().get('/api/v1/payments').expect(200)).body.data[0];
    const r = await ctx.http().get(`/api/v1/payments/${p.id}/receipt.pdf`);
    expect([200, 501]).toContain(r.status);
  });

  it('guardian balance sums all children where the guardian pays fees', async () => {
    ctx.as('BURSAR');
    const g = await addGuardian(ctx.k, [s1, s2]);
    const r = await ctx.http().get(`/api/v1/guardians/${g}/balance`).expect(200);
    expect(r.body.children).toHaveLength(2);
    expect(r.body.totalBalancePesewas).toBe((await balance(s1)) + (await balance(s2)));
  });

  it('crash inside the transaction leaves nothing behind and does not use up a receipt number', async () => {
    ctx.as('BURSAR');
    const svc = ctx.app.get(PaymentsService);
    const counter = async () => Number((await ctx.k.selectFrom('doc_counters').select('last_value').where('doc_type', '=', 'receipt').executeTakeFirstOrThrow()).last_value);
    const c0 = await counter();
    const n0 = (await ctx.k.selectFrom('payments').select('id').execute()).length;
    const a0 = (await ctx.k.selectFrom('payment_allocations').select('id').execute()).length;
    const l0 = (await ctx.k.selectFrom('ledger_entries').select('id').execute()).length;
    svc.faults.afterAllocations = () => { throw new Error('simulated crash'); };
    try {
      await pay(s1, 1_000).expect(500);
    } finally {
      svc.faults.afterAllocations = undefined;
    }
    expect(await counter()).toBe(c0);
    expect((await ctx.k.selectFrom('payments').select('id').execute()).length).toBe(n0);
    expect((await ctx.k.selectFrom('payment_allocations').select('id').execute()).length).toBe(a0);
    expect((await ctx.k.selectFrom('ledger_entries').select('id').execute()).length).toBe(l0);
    const next = await pay(s1, 1_000).expect(201);
    expect(Number(next.body.receiptNo.slice(4))).toBe(c0 + 1);
  });

  it('100 parallel payments get contiguous receipt numbers with no gaps or duplicates', async () => {
    ctx.as('BURSAR');
    const students = [s1, s2, s3];
    const before = Number((await ctx.k.selectFrom('doc_counters').select('last_value').where('doc_type', '=', 'receipt').executeTakeFirstOrThrow()).last_value);
    const res = await Promise.all(Array.from({ length: 100 }, (_, i) => pay(students[i % 3]!, 100 + i)));
    expect(res.every((r) => r.status === 201)).toBe(true);
    const nums = res.map((r) => Number(r.body.receiptNo.slice(4))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(100);
    expect(nums[0]).toBe(before + 1);
    expect(nums[99]).toBe(before + 100);
    const recon = await ctx.http().get('/api/v1/reports/reconciliation').expect(200);
    expect(recon.body.sections.receiptSequence).toMatchObject({ ok: true, gaps: [], duplicates: [] });
  });

  it('role denials and 404s', async () => {
    ctx.as('REGISTRAR');
    await pay(s1, 1_000).expect(403);
    await ctx.http().get(`/api/v1/students/${s1}/ledger`).expect(403);
    const regBal = await ctx.http().get(`/api/v1/students/${s1}/balance`).expect(200);
    expect(typeof regBal.body.balancePesewas).toBe('number');
    ctx.as('TEACHER');
    await ctx.http().get(`/api/v1/students/${s1}/balance`).expect(403);
    ctx.as('HEADTEACHER');
    await ctx.http().post('/api/v1/invoices/generate').set('Idempotency-Key', key()).send({ termId: school.termIds[0], scope: { type: 'school' }, dryRun: true }).expect(403);
    ctx.as('ADMIN');
    await pay(s1, 1_000).expect(403); // separation of duties: ADMIN does not record payments
    ctx.as('BURSAR');
    await ctx.http().get(`/api/v1/payments/${RANDOM_ID}`).expect(404);
    await ctx.http().get('/api/v1/payments/not-a-uuid').expect(404);
    await ctx.http().get(`/api/v1/invoices/${RANDOM_ID}`).expect(404);
    await ctx.http().get(`/api/v1/students/${RANDOM_ID}/balance`).expect(404);
    await pay(RANDOM_ID, 1_000).expect(404);
    // out of scope looks exactly like not found
    const scope = ctx.app.get(SCOPE_SERVICE, { strict: false }) as { canAccessStudent: (u: unknown, id: string) => Promise<boolean> };
    const orig = scope.canAccessStudent;
    scope.canAccessStudent = async (_u, id) => id !== s1;
    try {
      const p = (await ctx.http().get('/api/v1/payments').query({ studentId: s2 }).expect(200)).body.data[0];
      await ctx.http().get(`/api/v1/payments/${p.id}`).expect(200);
      const mine = (await ctx.k.selectFrom('payments').select('id').where('student_id', '=', s1).executeTakeFirstOrThrow()).id;
      await ctx.http().get(`/api/v1/payments/${mine}`).expect(404);
      await ctx.http().get(`/api/v1/students/${s1}/balance`).expect(404);
    } finally {
      scope.canAccessStudent = orig;
    }
  });

  it('ledger stays append-only at the database level', async () => {
    await expect(sql`update app.ledger_entries set amount_pesewas = 1`.execute(ctx.k)).rejects.toThrow();
  });
});
