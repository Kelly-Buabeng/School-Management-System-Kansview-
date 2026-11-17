import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AppError } from '../../../common/app-error';
import { FinanceBook } from './testing/finance-book';
import { ADJUSTMENT_TYPES, type AdjustmentType } from './types';
import { adjustmentEntry } from './ledger';

const FEE_ITEMS = [
  { feeItemId: 'tuition', priority: 1 },
  { feeItemId: 'pta', priority: 2 },
  { feeItemId: 'feeding', priority: 5 },
];

type Op =
  | { k: 'invoice'; term: number; amounts: number[] }
  | { k: 'pay'; amount: number; explicitPick: number | null }
  | { k: 'adjust'; type: AdjustmentType; term: number; feeIdx: number | null; amount: number }
  | { k: 'reversePayment'; pick: number }
  | { k: 'reverseAdjustment'; pick: number }
  | { k: 'void'; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('invoice' as const), term: fc.integer({ min: 1, max: 5 }), amounts: fc.array(fc.integer({ min: 0, max: 200_000 }), { minLength: 3, maxLength: 3 }) }) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant('pay' as const), amount: fc.integer({ min: 1, max: 300_000 }), explicitPick: fc.option(fc.nat(), { nil: null }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('adjust' as const), type: fc.constantFrom(...ADJUSTMENT_TYPES), term: fc.integer({ min: 1, max: 5 }), feeIdx: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }), amount: fc.integer({ min: 1, max: 100_000 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('reversePayment' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('reverseAdjustment' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('void' as const), pick: fc.nat() }) },
);

function run(book: FinanceBook, op: Op): void {
  switch (op.k) {
    case 'invoice':
      book.invoice(op.term, FEE_ITEMS.map((f, i) => ({ ...f, amount: op.amounts[i]! })));
      return;
    case 'pay': {
      const open = book.outstandingLines().filter((l) => l.outstandingPesewas > 0);
      if (op.explicitPick !== null && open.length > 0) {
        const l = open[op.explicitPick % open.length]!;
        const amt = Math.min(op.amount, l.outstandingPesewas);
        book.pay(op.amount, [{ invoiceLineId: l.invoiceLineId, amountPesewas: amt }]);
      } else book.pay(op.amount);
      return;
    }
    case 'adjust':
      try {
        book.adjust(op.type, op.term, op.feeIdx === null ? null : FEE_ITEMS[op.feeIdx]!.feeItemId, op.amount);
      } catch (e) {
        if (!(e instanceof AppError)) throw e; // over-limit adjustments are refused, like the API does
      }
      return;
    case 'reversePayment': {
      const c = book.payments.filter((p) => p.status === 'confirmed');
      if (c.length) book.reversePayment(c[op.pick % c.length]!.id);
      return;
    }
    case 'reverseAdjustment': {
      const c = book.adjustments.filter((a) => a.status === 'approved');
      if (c.length) book.reverseAdjustment(c[op.pick % c.length]!.id);
      return;
    }
    case 'void': {
      const c = book.invoices.filter((i) => i.status === 'issued');
      if (c.length) book.voidInvoice(c[op.pick % c.length]!.id);
      return;
    }
  }
}

function checkInvariants(book: FinanceBook): void {
  const liveInvoices = new Set(book.invoices.filter((i) => i.status === 'issued').map((i) => i.id));
  const invoiced = book.lines.filter((l) => liveInvoices.has(l.invoiceId)).reduce((s, l) => s + l.amount, 0);
  const paid = book.payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0);
  const adjusted = book.adjustments.filter((a) => a.status === 'approved').reduce((s, a) => s + adjustmentEntry(a.type, a.amount), 0);
  // balance == Σ invoices − Σ payments − Σ approved (credit) adjustments (+ debit adjustments)
  expect(book.balance()).toBe(invoiced - paid + adjusted);

  for (const l of book.lines) {
    const alloc = book.allocs.filter((a) => a.invoiceLineId === l.id).reduce((s, a) => s + a.amount, 0);
    expect(alloc).toBeGreaterThanOrEqual(0);
    expect(alloc).toBeLessThanOrEqual(l.amount);
    if (!liveInvoices.has(l.invoiceId)) expect(alloc).toBe(0);
  }
  for (const p of book.payments) {
    const rows = book.allocs.filter((a) => a.paymentId === p.id);
    const total = rows.reduce((s, a) => s + a.amount, 0);
    expect(total).toBe(p.status === 'confirmed' ? p.amount : 0);
    expect(book.unallocatedOf(p.id)).toBeGreaterThanOrEqual(0);
  }
  // no reversal reverses the same entry twice
  const reversed = book.ledger.filter((e) => e.reverses !== undefined).map((e) => e.reverses);
  expect(new Set(reversed).size).toBe(reversed.length);
}

describe('ledger property: random invoices, payments, adjustments and reversals', () => {
  it('balance always equals invoices − payments − approved adjustments; allocations never exceed lines', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const book = new FinanceBook();
        for (const op of ops) {
          run(book, op);
          checkInvariants(book);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('overpayment becomes credit that the next term invoice consumes', () => {
    const book = new FinanceBook();
    book.invoice(1, [{ feeItemId: 'tuition', priority: 1, amount: 100_000 }]);
    const p = book.pay(150_000);
    expect(book.balance()).toBe(-50_000);
    expect(book.unallocatedOf(p)).toBe(50_000);
    book.invoice(2, [{ feeItemId: 'tuition', priority: 1, amount: 120_000 }]);
    expect(book.unallocatedOf(p)).toBe(0);
    expect(book.balance()).toBe(70_000);
    expect(book.outstandingLines().find((l) => l.termKey === 2)!.outstandingPesewas).toBe(70_000);
  });

  it('reversal restores the balance and frees the lines', () => {
    const book = new FinanceBook();
    book.invoice(1, [{ feeItemId: 'tuition', priority: 1, amount: 100_000 }]);
    const p = book.pay(40_000);
    expect(book.balance()).toBe(60_000);
    book.reversePayment(p);
    expect(book.balance()).toBe(100_000);
    expect(book.netAllocationsOf(p)).toEqual([]);
    expect(() => book.reversePayment(p)).toThrow();
  });

  it('a late discount spread onto a paid line moves that money onto other open lines', () => {
    const book = new FinanceBook();
    book.invoice(1, [{ feeItemId: 'tuition', priority: 1, amount: 1000 }, { feeItemId: 'feeding', priority: 5, amount: 600 }]);
    const feeding = book.lines.find((l) => l.feeItemId === 'feeding')!;
    const p = book.pay(600, [{ invoiceLineId: feeding.id, amountPesewas: 600 }]);
    book.adjust('discount', 1, null, 500); // reduces feeding first (paid last), which is already paid
    expect(book.balance()).toBe(500);
    const outs = Object.fromEntries(book.lineStates().map((l) => [l.invoiceLineId, l.outstandingPesewas]));
    expect(outs[feeding.id]).toBe(0);
    expect(Object.values(outs).reduce((a, b) => a + b, 0)).toBe(500);
    expect(book.unallocatedOf(p)).toBe(0);
  });

  it('discount larger than what is owed is refused', () => {
    const book = new FinanceBook();
    book.invoice(1, [{ feeItemId: 'tuition', priority: 1, amount: 1000 }]);
    book.pay(1000);
    expect(() => book.adjust('discount', 1, 'tuition', 1)).toThrow(AppError);
  });

  it('void is blocked while money is allocated, allowed otherwise', () => {
    const book = new FinanceBook();
    const inv = book.invoice(1, [{ feeItemId: 'tuition', priority: 1, amount: 1000 }])!;
    expect(book.invoice(1, [{ feeItemId: 'tuition', priority: 1, amount: 1000 }])).toBeNull();
    const p = book.pay(10);
    expect(book.voidInvoice(inv)).toBe(false);
    book.reversePayment(p);
    expect(book.voidInvoice(inv)).toBe(true);
    expect(book.balance()).toBe(0);
  });
});
