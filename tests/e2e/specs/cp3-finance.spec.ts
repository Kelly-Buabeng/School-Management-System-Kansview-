// Owner: Agent H. CP3: invoice → payment → receipt → balance, on the seeded school (definition-of-done.md).
import { test, expect } from '../support/fixtures';
import { idemKey, type ApiSession } from '../support/api';
import { classByName, currentYear, list } from '../support/data';

test.describe.configure({ mode: 'serial' });

const now = () => new Date().toISOString();
const momoRef = () => `61${Date.now().toString().slice(-9)}`;

async function balance(s: ApiSession, id: string): Promise<number> {
  return (await s.json<{ balancePesewas: number }>(s.get(`/students/${id}/balance`))).balancePesewas;
}

/** A seeded student in the class who still owes money this term. */
async function studentOwing(s: ApiSession, className: string, minPesewas: number): Promise<{ id: string; levelId: string; owed: number }> {
  const cls = await classByName(s, className);
  const students = list<{ id: string }>(await s.json(s.get('/students', { classId: cls.id, pageSize: 60 })));
  for (const st of students) {
    const owed = await balance(s, st.id);
    if (owed >= minPesewas) return { id: st.id, levelId: cls.levelId, owed };
  }
  throw new Error(`no student in ${className} owes ${minPesewas}`);
}

let student = { id: '', levelId: '', owed: 0 };
let partialPaymentId = '';
let ref = '';

test('partial MoMo payment: sequential receipt, oldest-first allocation, balance reduced, receipt PDF', async ({ api }) => {
  const bursar = await api.as('bursar');
  student = await studentOwing(bursar, 'Primary 5 A', 20_000);
  ref = momoRef();
  const pay = await bursar.json<{ id: string; receiptNo: string; status: string; balanceAfterPesewas: number; allocations: unknown[] }>(
    bursar.post('/payments', { studentId: student.id, amountPesewas: 10_000, method: 'momo_mtn', referenceNo: ref, receivedAt: now(), payerName: 'Ama Mensah' }, { idempotencyKey: idemKey() }),
    201,
  );
  partialPaymentId = pay.id;
  expect(pay.receiptNo).toMatch(/^RCP-\d{6}$/);
  expect(pay.status).toBe('confirmed');
  expect(pay.allocations.length).toBeGreaterThan(0);
  expect(pay.balanceAfterPesewas).toBe(student.owed - 10_000);
  expect(await balance(bursar, student.id)).toBe(student.owed - 10_000);

  const pdf = await bursar.get(`/payments/${pay.id}/receipt.pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('same MoMo reference again: duplicate warning, then override with a reason (audited)', async ({ api }) => {
  const bursar = await api.as('bursar');
  const body = { studentId: student.id, amountPesewas: 1_000, method: 'momo_mtn', referenceNo: ref, receivedAt: now(), payerName: 'Ama Mensah' };
  const dup = await bursar.post('/payments', body, { idempotencyKey: idemKey() });
  expect(dup.status()).toBe(409);
  expect(((await dup.json()) as { code: string }).code).toBe('PAYMENT_DUPLICATE_REFERENCE');
  const ok = await bursar.json<{ id: string }>(
    bursar.post('/payments', { ...body, confirmDuplicate: true, duplicateOverrideReason: 'One MoMo transfer for two fees (e2e)' }, { idempotencyKey: idemKey() }),
    201,
  );
  const admin = await api.as('admin');
  const events = list<{ entityId: string; reason: string | null }>(await admin.json(admin.get('/audit-events', { studentId: student.id })));
  expect(events.some((e) => e.entityId === ok.id && (e.reason ?? '').includes('Duplicate reference override'))).toBe(true);
});

test('idempotent replay returns the same receipt and creates nothing new', async ({ api }) => {
  const bursar = await api.as('bursar');
  const key = idemKey();
  const body = { studentId: student.id, amountPesewas: 500, method: 'cash', receivedAt: now(), payerName: 'Kofi Mensah' };
  const a = await bursar.json<{ id: string; receiptNo: string }>(bursar.post('/payments', body, { idempotencyKey: key }), 201);
  const before = await balance(bursar, student.id);
  const bRes = await bursar.post('/payments', body, { idempotencyKey: key });
  expect(bRes.status()).toBe(201);
  expect(bRes.headers()['idempotent-replayed']).toBe('true');
  expect(((await bRes.json()) as { receiptNo: string }).receiptNo).toBe(a.receiptNo);
  expect(await balance(bursar, student.id)).toBe(before);
});

test('same-day reversal posts a reversal entry and restores the balance', async ({ api }) => {
  const bursar = await api.as('bursar');
  const before = await balance(bursar, student.id);
  const r = await bursar.post(`/payments/${partialPaymentId}/reverse`, { reason: 'Wrong student selected (e2e)' }, { idempotencyKey: idemKey() });
  if (r.status() === 202) {
    // A cash-up was already closed today: the reversal waits for ADMIN approval (CR-0003).
    const admin = await api.as('admin');
    await admin.json(admin.post(`/payments/${partialPaymentId}/reverse/approve`));
  } else {
    expect(r.status(), await r.text()).toBe(200);
  }
  const p = await bursar.json<{ status: string }>(bursar.get(`/payments/${partialPaymentId}`));
  expect(p.status).toBe('reversed');
  expect(await balance(bursar, student.id)).toBe(before + 10_000);
  const ledger = await bursar.json<{ entries: Array<{ entryType: string; paymentId: string | null; amountPesewas: number }> }>(bursar.get(`/students/${student.id}/ledger`));
  expect(ledger.entries.some((e) => e.entryType === 'reversal' && e.paymentId === partialPaymentId && e.amountPesewas === 10_000)).toBe(true);
  const again = await bursar.post(`/payments/${partialPaymentId}/reverse`, { reason: 'again' }, { idempotencyKey: idemKey() });
  expect(again.status()).toBe(409);
});

test('overpayment becomes credit, and the next term invoice uses it (brought forward)', async ({ api }) => {
  const bursar = await api.as('bursar');
  const owed = await balance(bursar, student.id);
  const over = await bursar.json<{ creditCreatedPesewas: number; balanceAfterPesewas: number }>(
    bursar.post('/payments', { studentId: student.id, amountPesewas: owed + 25_000, method: 'cash', receivedAt: now(), payerName: 'Ama Mensah' }, { idempotencyKey: idemKey() }),
    201,
  );
  expect(over.creditCreatedPesewas).toBe(25_000);
  expect(over.balanceAfterPesewas).toBe(-25_000);

  // Term 2 fee structure for the level is a draft in the seed: ADMIN activates it, the bursar invoices this child.
  const year = await currentYear(bursar);
  const term2 = year.terms.find((t) => t.number === 2)!;
  const structures = list<{ id: string; levelId: string; status: string }>(await bursar.json(bursar.get('/fee-structures', { termId: term2.id })));
  const st = structures.find((x) => x.levelId === student.levelId);
  expect(st, 'term 2 structure for the level').toBeTruthy();
  if (st!.status === 'draft') {
    const admin = await api.as('admin');
    await admin.json(admin.post(`/fee-structures/${st!.id}/activate`));
  }
  const gen = await bursar.json<{ invoices: Array<{ invoiceId: string; openingBalancePesewas: number; creditAppliedPesewas: number; totalPesewas: number }> }>(
    bursar.post('/invoices/generate', { termId: term2.id, scope: { type: 'student', ids: [student.id] }, dryRun: false }, { idempotencyKey: idemKey() }),
    201,
  );
  expect(gen.invoices).toHaveLength(1);
  expect(gen.invoices[0]).toMatchObject({ openingBalancePesewas: -25_000, creditAppliedPesewas: 25_000 });
  expect(await balance(bursar, student.id)).toBe(gen.invoices[0]!.totalPesewas - 25_000);
});

test('guardian balance sums all their children', async ({ api }) => {
  const bursar = await api.as('bursar');
  const g = list<{ id: string; isFeePayer?: boolean }>(await bursar.json(bursar.get(`/students/${student.id}/guardians`)))[0]!;
  const gb = await bursar.json<{ totalBalancePesewas: number; children: Array<{ balancePesewas: number }> }>(bursar.get(`/guardians/${g.id}/balance`));
  expect(gb.totalBalancePesewas).toBe(gb.children.reduce((a, c) => a + c.balancePesewas, 0));
});

test('UI: bursar opens Record payment', async ({ page, signIn }) => {
  test.fixme(true, 'The bursar must pass TOTP in the UI; add once the MFA screen exposes a stable label (needs Agent E).');
  await signIn(page, 'bursar');
});
