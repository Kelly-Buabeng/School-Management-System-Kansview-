import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInAccra } from '@sms/shared';
import { LEDGER_SERVICE, type LedgerService } from '../../src/common/contracts';
import { activeStructure, addGuardian, addStudent, key, seedSchool, setupC, USERS, type Ctx, type School } from './helpers';

describe('ledger service, adjustments (maker-checker), cash-ups and reports', () => {
  let ctx: Ctx;
  let school: School;
  let s1: string; let s2: string; let sib: string;
  let pastTermId: string;

  const now = () => new Date().toISOString();
  const pay = (studentId: string, amountPesewas: number, extra: Record<string, unknown> = {}) =>
    ctx.http().post('/api/v1/payments').set('Idempotency-Key', key()).send({ studentId, amountPesewas, method: 'cash', receivedAt: now(), payerName: 'Kofi Owusu', ...extra });
  const ledger = () => ctx.app.get<LedgerService>(LEDGER_SERVICE as never, { strict: false });

  beforeAll(async () => {
    ctx = await setupC();
    school = await seedSchool(ctx.k);
    s1 = await addStudent(ctx.k, school.classes.P1A, school.yearId, { dob: '2018-03-01' });
    s2 = await addStudent(ctx.k, school.classes.P1A, school.yearId, { dob: '2018-05-01' });
    sib = await addStudent(ctx.k, school.classes.P2A, school.yearId, { dob: '2016-02-01' });
    await addGuardian(ctx.k, [s1, sib]);
    // a past term with an opening balance (arrears) for s1
    const py = await ctx.k.insertInto('academic_years').values({ name: '2025/2026', start_date: '2025-09-01', end_date: '2026-07-31', status: 'closed' }).returning('id').executeTakeFirstOrThrow();
    pastTermId = (await ctx.k.insertInto('terms').values({ academic_year_id: py.id, number: 3, name: 'Term 3 (2025/2026)', start_date: '2026-04-27', end_date: '2026-07-24', status: 'closed' }).returning('id').executeTakeFirstOrThrow()).id;
    await ctx.k.insertInto('ledger_entries').values({ student_id: s1, term_id: pastTermId, entry_type: 'opening_balance', amount_pesewas: 30_000, description: 'Opening balance from old system', posted_by: USERS.ADMIN }).execute();
    await activeStructure(ctx, school.termIds[0]!, school.levels.P1, [{ feeItemId: school.feeItems.tuition, amountPesewas: 100_000 }, { feeItemId: school.feeItems.feeding, amountPesewas: 20_000 }]);
    await activeStructure(ctx, school.termIds[0]!, school.levels.P2, [{ feeItemId: school.feeItems.tuition, amountPesewas: 120_000 }]);
    ctx.as('BURSAR');
    await ctx.http().post('/api/v1/invoices/generate').set('Idempotency-Key', key()).send({ termId: school.termIds[0], scope: { type: 'school' }, dryRun: false }).expect(201);
  });
  afterAll(async () => ctx?.close());

  it('LedgerService: balance split into current term and arrears; batch outstanding; term summary', async () => {
    const b = await ledger().balance(s1);
    expect(b).toMatchObject({ balancePesewas: 150_000, currentTermOutstandingPesewas: 120_000, arrearsPesewas: 30_000, creditPesewas: 0, lastPaymentAt: null });
    const inv = (await ctx.k.selectFrom('invoices').select('opening_balance_pesewas').where('student_id', '=', s1).executeTakeFirstOrThrow());
    expect(Number(inv.opening_balance_pesewas)).toBe(30_000);
    ctx.as('BURSAR');
    await pay(s1, 50_000).expect(201);
    const m = await ledger().outstandingByStudent([s1, s2, '01900000-0000-7000-8000-00000000beef']);
    expect([...m.values()]).toEqual([100_000, 120_000, 0]);
    expect(await ledger().termCollectionSummary(school.termIds[0]!)).toEqual({ billedPesewas: 360_000, collectedPesewas: 50_000, outstandingPesewas: 310_000 });
    const after = await ledger().balance(s1);
    expect(after.currentTermOutstandingPesewas + after.arrearsPesewas).toBe(100_000);
    expect(after.lastPaymentAt).toBeTruthy();
    const school_ = (await ctx.http().get('/api/v1/balances/school').expect(200)).body;
    expect(school_).toMatchObject({ totalOwedPesewas: 340_000, studentsOwing: 3 });
    const classes = (await ctx.http().get('/api/v1/balances/classes').expect(200)).body;
    expect(classes.data.find((c: { className: string }) => c.className === 'Primary 1 A')).toMatchObject({ students: 2, billedPesewas: 240_000, paidPesewas: 50_000 });
  });

  it('adjustments: percentage discount needs a second approver; self-approval refused; bursar cannot approve', async () => {
    ctx.as('BURSAR');
    await ctx.http().post('/api/v1/adjustments').send({ studentId: s2, termId: school.termIds[0], type: 'discount', feeItemId: school.feeItems.tuition, percentBasisPoints: 1000, reason: 'Staff child discount' }).expect(400);
    const req = await ctx.http().post('/api/v1/adjustments').set('Idempotency-Key', key())
      .send({ studentId: s2, termId: school.termIds[0], type: 'discount', feeItemId: school.feeItems.tuition, percentBasisPoints: 1000, reason: 'Staff child discount' }).expect(201);
    expect(req.body).toMatchObject({ status: 'pending', amountPesewas: 10_000, percentBasisPoints: 1000 });
    await ctx.http().post(`/api/v1/adjustments/${req.body.id}/approve`).send({}).expect(403);
    ctx.as('ADMIN');
    const own = await ctx.http().post('/api/v1/adjustments').set('Idempotency-Key', key()).send({ studentId: s2, termId: school.termIds[0], type: 'waiver', amountPesewas: 1_000, reason: 'Admin own request' }).expect(201);
    const self = await ctx.http().post(`/api/v1/adjustments/${own.body.id}/approve`).send({}).expect(403);
    expect(self.body.code).toBe('ADJUSTMENT_SELF_APPROVAL');
    ctx.as('HEADTEACHER');
    await ctx.http().post(`/api/v1/adjustments/${own.body.id}/reject`).send({ reason: 'Not needed' }).expect(200);
    const ok = await ctx.http().post(`/api/v1/adjustments/${req.body.id}/approve`).send({ reason: 'Approved by head' }).expect(200);
    expect(ok.body).toMatchObject({ status: 'approved', approvedBy: USERS.HEADTEACHER });
    expect((await ledger().balance(s2)).balancePesewas).toBe(110_000);
    const again = await ctx.http().post(`/api/v1/adjustments/${req.body.id}/approve`).send({}).expect(409);
    expect(again.body.code).toBe('ADJUSTMENT_INVALID_STATE');
    const inv = (await ctx.http().get('/api/v1/invoices').query({ studentId: s2 }).expect(200)).body.data[0];
    const full = (await ctx.http().get(`/api/v1/invoices/${inv.id}`).expect(200)).body;
    expect(full).toMatchObject({ adjustmentsPesewas: 10_000, outstandingPesewas: 110_000 });
    // reverse restores the balance
    const rev = await ctx.http().post(`/api/v1/adjustments/${req.body.id}/reverse`).send({ reason: 'Granted in error' }).expect(200);
    expect(rev.body.status).toBe('reversed');
    expect((await ledger().balance(s2)).balancePesewas).toBe(120_000);
  });

  it('adjustments: refund needs ADMIN; discount above what is owed is refused', async () => {
    ctx.as('BURSAR');
    const big = await ctx.http().post('/api/v1/adjustments').set('Idempotency-Key', key()).send({ studentId: s2, termId: school.termIds[0], type: 'bursary', amountPesewas: 999_999, reason: 'Too big on purpose' }).expect(201);
    ctx.as('HEADTEACHER');
    const r = await ctx.http().post(`/api/v1/adjustments/${big.body.id}/approve`).send({}).expect(422);
    expect(r.body.code).toBe('ADJUSTMENT_INVALID_STATE');
    ctx.as('BURSAR');
    await pay(s2, 130_000).expect(201); // 10_000 credit
    const refund = await ctx.http().post('/api/v1/adjustments').set('Idempotency-Key', key()).send({ studentId: s2, termId: school.termIds[0], type: 'refund', amountPesewas: 10_000, reason: 'Return overpayment to parent' }).expect(201);
    ctx.as('HEADTEACHER');
    await ctx.http().post(`/api/v1/adjustments/${refund.body.id}/approve`).send({}).expect(403);
    ctx.as('ADMIN');
    await ctx.http().post(`/api/v1/adjustments/${refund.body.id}/approve`).send({}).expect(200);
    expect((await ledger().balance(s2)).balancePesewas).toBe(0);
    const list = (await ctx.http().get('/api/v1/adjustments').query({ status: 'pending' }).expect(200)).body.data;
    expect(list.map((a: { id: string }) => a.id)).toContain(big.body.id);
  });

  it('sibling discount suggestion (suggestion only)', async () => {
    ctx.as('BURSAR');
    const r = await ctx.http().get(`/api/v1/students/${s1}/sibling-discount-suggestion`).query({ termId: school.termIds[0] }).expect(200);
    expect(r.body.siblings).toHaveLength(2);
    expect(r.body.thisStudent).toMatchObject({ studentId: s1, amountPesewas: 10_000 }); // s1 is younger than sib
    expect(r.body.suggestions.find((s: { studentId: string }) => s.studentId === sib)).toBeUndefined();
  });

  it('cash-up: open, expected by method, close with variance', async () => {
    ctx.as('BURSAR');
    const cu = await ctx.http().post('/api/v1/cash-ups').send({ notes: 'Morning float GH₵ 0' }).expect(201);
    await ctx.http().post('/api/v1/cash-ups').send({}).expect(409);
    await pay(s1, 2_000, { method: 'telecel_cash', referenceNo: 'TC-55501' }).expect(201);
    const open = (await ctx.http().get(`/api/v1/cash-ups/${cu.body.id}`).expect(200)).body;
    expect(open.expectedByMethod.cash).toBe(50_000 + 130_000);
    expect(open.expectedByMethod.telecel_cash).toBe(2_000);
    const closed = await ctx.http().post(`/api/v1/cash-ups/${cu.body.id}/close`).send({ countedByMethod: { cash: 179_900, telecel_cash: 2_000 }, notes: 'GH₵1 short' }).expect(200);
    expect(closed.body).toMatchObject({ status: 'closed', variancePesewas: -100 });
    expect(closed.body.varianceByMethod.cash).toBe(-100);
    await ctx.http().post(`/api/v1/cash-ups/${cu.body.id}/close`).send({ countedByMethod: {} }).expect(409);
    ctx.as('REGISTRAR');
    await ctx.http().get('/api/v1/cash-ups').expect(403);
    ctx.as('HEADTEACHER');
    await ctx.http().get('/api/v1/cash-ups').expect(200);
    await ctx.http().post(`/api/v1/cash-ups/${cu.body.id}/close`).send({ countedByMethod: {} }).expect(403);
  });

  it('reports: collections, aging, defaulters, daily cash-up, reconciliation; xlsx export; role denial', async () => {
    ctx.as('HEADTEACHER');
    const byMethod = (await ctx.http().get('/api/v1/reports/collections').query({ groupBy: 'method' }).expect(200)).body;
    expect(byMethod.totals.amountPesewas).toBe(50_000 + 130_000 + 2_000);
    const byFee = (await ctx.http().get('/api/v1/reports/collections').query({ groupBy: 'fee_item' }).expect(200)).body;
    expect(byFee.rows.find((r: { group: string }) => r.group === 'Tuition').amountPesewas).toBeGreaterThan(0);
    const byDay = (await ctx.http().get('/api/v1/reports/collections').query({ groupBy: 'day', from: todayInAccra(), to: todayInAccra() }).expect(200)).body;
    expect(byDay.rows).toHaveLength(1);
    const aging = (await ctx.http().get('/api/v1/reports/aging').expect(200)).body;
    const a1 = aging.rows.find((r: { studentId: string }) => r.studentId === s1);
    expect(a1.totalPesewas).toBe(98_000);
    const def = (await ctx.http().get('/api/v1/reports/defaulters').query({ minOutstandingPesewas: 100_000 }).expect(200)).body;
    expect(def.rows.map((r: { studentId: string }) => r.studentId)).toEqual([sib]);
    const daily = (await ctx.http().get('/api/v1/reports/daily-cash-up').query({ date: todayInAccra() }).expect(200)).body;
    expect(daily.rows).toHaveLength(3);
    expect(daily.sections.cashUp.status).toBe('closed');
    const recon = (await ctx.http().get('/api/v1/reports/reconciliation').expect(200)).body;
    expect(recon.sections.receiptSequence.ok).toBe(true);
    const xlsx = await ctx.http().get('/api/v1/reports/aging').query({ format: 'xlsx' }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    ctx.as('REGISTRAR');
    await ctx.http().get('/api/v1/reports/aging').expect(403);
    ctx.as('BURSAR');
    await ctx.http().get('/api/v1/reports/daily-cash-up').expect(400);
  });
});
