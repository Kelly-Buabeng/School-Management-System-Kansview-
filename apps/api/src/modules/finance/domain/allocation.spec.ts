import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AppError } from '../../../common/app-error';
import {
  allocatePayment, applyCredit, autoAllocate, capCreditSources, netAllocations, planCreditReconciliation,
  reallocationRows, reversalRows, sortForAllocation, validateExplicitAllocations, lineOutstanding,
} from './allocation';
import type { OutstandingLine } from './types';

const line = (id: string, termKey: string, prio: number, out: number, seq = 0): OutstandingLine => ({ invoiceLineId: id, termKey, allocationPriority: prio, sequence: seq, outstandingPesewas: out });

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof AppError ? e.code : 'OTHER'; }
  return undefined;
};

describe('autoAllocate', () => {
  const lines = [
    line('t2-tuition', '2026-09-01', 1, 100_000),
    line('t1-feeding', '2026-01-10', 5, 20_000),
    line('t1-tuition', '2026-01-10', 1, 50_000),
    line('t2-pta', '2026-09-01', 2, 5_000),
  ];

  it('pays the oldest term first, then by fee item priority', () => {
    expect(sortForAllocation(lines).map((l) => l.invoiceLineId)).toEqual(['t1-tuition', 't1-feeding', 't2-tuition', 't2-pta']);
    const r = autoAllocate(60_000, lines);
    expect(r.allocations).toEqual([
      { invoiceLineId: 't1-tuition', amountPesewas: 50_000 },
      { invoiceLineId: 't1-feeding', amountPesewas: 10_000 },
    ]);
    expect(r.unallocatedPesewas).toBe(0);
  });

  it('partial payment touches only the first line', () => {
    expect(autoAllocate(1, lines).allocations).toEqual([{ invoiceLineId: 't1-tuition', amountPesewas: 1 }]);
  });

  it('overpayment leaves unallocated credit', () => {
    const r = autoAllocate(200_000, lines);
    expect(r.unallocatedPesewas).toBe(25_000);
    expect(r.allocations).toHaveLength(4);
  });

  it('skips settled lines and handles no lines', () => {
    expect(autoAllocate(10, [line('a', '1', 1, 0)])).toEqual({ allocations: [], unallocatedPesewas: 10 });
    expect(autoAllocate(0, lines)).toEqual({ allocations: [], unallocatedPesewas: 0 });
  });

  it('rejects negative or fractional amounts', () => {
    expect(() => autoAllocate(-1, lines)).toThrow(RangeError);
    expect(() => autoAllocate(1.5, lines)).toThrow(RangeError);
  });

  it('property: allocations sum + credit = amount and no line gets more than it owes', () => {
    const arbLines = fc.array(
      fc.record({ termKey: fc.integer({ min: 1, max: 6 }), prio: fc.integer({ min: 0, max: 9 }), out: fc.integer({ min: 0, max: 1_000_000 }) }),
      { maxLength: 12 },
    ).map((xs) => xs.map((x, i) => ({ invoiceLineId: `l${i}`, termKey: x.termKey, allocationPriority: x.prio, sequence: i, outstandingPesewas: x.out })));
    fc.assert(fc.property(arbLines, fc.integer({ min: 0, max: 5_000_000 }), (ls, amount) => {
      const r = autoAllocate(amount, ls);
      const sum = r.allocations.reduce((s, a) => s + a.amountPesewas, 0);
      expect(sum + r.unallocatedPesewas).toBe(amount);
      for (const a of r.allocations) {
        expect(a.amountPesewas).toBeGreaterThan(0);
        expect(a.amountPesewas).toBeLessThanOrEqual(ls.find((l) => l.invoiceLineId === a.invoiceLineId)!.outstandingPesewas);
      }
      const owed = ls.reduce((s, l) => s + l.outstandingPesewas, 0);
      expect(r.unallocatedPesewas).toBe(Math.max(0, amount - owed));
    }));
  });
});

describe('validateExplicitAllocations', () => {
  const lines = [line('a', '1', 1, 1000), line('b', '1', 2, 500)];

  it('accepts allocations within limits; remainder becomes credit', () => {
    expect(validateExplicitAllocations(2000, [{ invoiceLineId: 'b', amountPesewas: 500 }], lines)).toEqual({
      allocations: [{ invoiceLineId: 'b', amountPesewas: 500 }],
      unallocatedPesewas: 1500,
    });
  });

  it('merges repeated lines before checking', () => {
    expect(code(() => validateExplicitAllocations(2000, [{ invoiceLineId: 'b', amountPesewas: 300 }, { invoiceLineId: 'b', amountPesewas: 300 }], lines))).toBe('PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING');
  });

  it('refuses more than the line outstanding, unknown lines, zero, and sum over amount', () => {
    expect(code(() => validateExplicitAllocations(5000, [{ invoiceLineId: 'a', amountPesewas: 1001 }], lines))).toBe('PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING');
    expect(code(() => validateExplicitAllocations(5000, [{ invoiceLineId: 'zzz', amountPesewas: 1 }], lines))).toBe('PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING');
    expect(code(() => validateExplicitAllocations(5000, [{ invoiceLineId: 'a', amountPesewas: 0 }], lines))).toBe('VALIDATION_FAILED');
    expect(code(() => validateExplicitAllocations(1200, [{ invoiceLineId: 'a', amountPesewas: 1000 }, { invoiceLineId: 'b', amountPesewas: 500 }], lines))).toBe('PAYMENT_ALLOCATION_EXCEEDS_AMOUNT');
  });

  it('allocatePayment picks explicit or automatic', () => {
    expect(allocatePayment(100, lines, []).allocations[0]!.invoiceLineId).toBe('a');
    expect(allocatePayment(100, lines, null).allocations[0]!.invoiceLineId).toBe('a');
    expect(allocatePayment(100, lines, [{ invoiceLineId: 'b', amountPesewas: 100 }]).allocations[0]!.invoiceLineId).toBe('b');
  });
});

describe('credit', () => {
  const lines = [line('n1', '2', 1, 3000), line('n2', '2', 2, 2000)];

  it('applies the oldest credit first and never more than owed', () => {
    const apps = applyCredit([
      { paymentId: 'p2', receivedAt: '2026-02-01', receiptNo: 'RCP-2', unallocatedPesewas: 4000 },
      { paymentId: 'p1', receivedAt: '2026-01-01', receiptNo: 'RCP-1', unallocatedPesewas: 1000 },
      { paymentId: 'p0', receivedAt: '2025-01-01', receiptNo: 'RCP-0', unallocatedPesewas: 0 },
    ], lines);
    expect(apps).toEqual([
      { paymentId: 'p1', invoiceLineId: 'n1', amountPesewas: 1000 },
      { paymentId: 'p2', invoiceLineId: 'n1', amountPesewas: 2000 },
      { paymentId: 'p2', invoiceLineId: 'n2', amountPesewas: 2000 },
    ]);
    const tooMuch = applyCredit([{ paymentId: 'p', receivedAt: 'x', receiptNo: 'x', unallocatedPesewas: 99_999 }], lines);
    expect(tooMuch.reduce((s, a) => s + a.amountPesewas, 0)).toBe(5000);
  });

  it('capCreditSources trims oldest-first to the cap', () => {
    const s = [
      { paymentId: 'b', receivedAt: '2', receiptNo: '2', unallocatedPesewas: 500 },
      { paymentId: 'a', receivedAt: '1', receiptNo: '1', unallocatedPesewas: 300 },
    ];
    expect(capCreditSources(s, 400)).toEqual([
      { paymentId: 'a', receivedAt: '1', receiptNo: '1', unallocatedPesewas: 300 },
      { paymentId: 'b', receivedAt: '2', receiptNo: '2', unallocatedPesewas: 100 },
    ]);
    expect(capCreditSources(s, -5)).toEqual([]);
  });
});

describe('allocation rows', () => {
  it('net, reversal and re-allocation rows', () => {
    const rows = [
      { invoiceLineId: 'a', amountPesewas: 700 },
      { invoiceLineId: null, amountPesewas: 300 },
      { invoiceLineId: null, amountPesewas: -300 },
      { invoiceLineId: 'b', amountPesewas: 300 },
    ];
    expect(netAllocations(rows)).toEqual([{ invoiceLineId: 'a', amountPesewas: 700 }, { invoiceLineId: 'b', amountPesewas: 300 }]);
    expect(reversalRows(rows)).toEqual([{ invoiceLineId: 'a', amountPesewas: -700 }, { invoiceLineId: 'b', amountPesewas: -300 }]);
    const re = reallocationRows(rows, [{ invoiceLineId: 'b', amountPesewas: 600 }], 1000);
    expect(re).toEqual([
      { invoiceLineId: 'a', amountPesewas: -700 },
      { invoiceLineId: 'b', amountPesewas: 300 },
      { invoiceLineId: null, amountPesewas: 400 },
    ]);
    expect(netAllocations([...rows, ...re])).toEqual([{ invoiceLineId: null, amountPesewas: 400 }, { invoiceLineId: 'b', amountPesewas: 600 }]);
    expect(() => reallocationRows(rows, [{ invoiceLineId: 'b', amountPesewas: 1001 }], 1000)).toThrow(RangeError);
    expect(lineOutstanding(1000, [700, -200])).toBe(500);
  });
});

describe('planCreditReconciliation', () => {
  it('moves over-paid line money to credit then onto other open lines', () => {
    // line a: 1000 paid fully by p1, then a 400 discount makes it -400. line b owes 600. balance = 600 - 400 = 200.
    const moves = planCreditReconciliation([
      { invoiceLineId: 'a', termKey: 1, allocationPriority: 1, sequence: 1, outstandingPesewas: -400, paidBy: [{ paymentId: 'p1', receivedAt: '1', receiptNo: '1', amountPesewas: 1000 }] },
      { invoiceLineId: 'b', termKey: 1, allocationPriority: 2, sequence: 2, outstandingPesewas: 600, paidBy: [] },
    ], [], 200);
    expect(moves).toEqual([
      { paymentId: 'p1', invoiceLineId: 'a', amountPesewas: -400 },
      { paymentId: 'p1', invoiceLineId: null, amountPesewas: 400 },
      { paymentId: 'p1', invoiceLineId: null, amountPesewas: -400 },
      { paymentId: 'p1', invoiceLineId: 'b', amountPesewas: 400 },
    ]);
  });

  it('does not apply credit already used by a charge with no invoice line', () => {
    // 500 unallocated, but a 500 manual charge means the family has no free credit: balance 1000 = outstanding 1000.
    const moves = planCreditReconciliation(
      [{ invoiceLineId: 'n', termKey: 2, allocationPriority: 1, sequence: 1, outstandingPesewas: 1000, paidBy: [] }],
      [{ paymentId: 'p', receivedAt: '1', receiptNo: '1', unallocatedPesewas: 500 }],
      1000,
    );
    expect(moves).toEqual([]);
  });
});
