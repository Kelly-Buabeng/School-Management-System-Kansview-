import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AppError } from '../../../common/app-error';
import { cleanReference, referenceKey, requiresReference, validateReference, methodLabel } from './references';
import { adjustmentEntry, balanceOf, chargeEntry, isCreditAdjustment, paymentEntry, reversalEntry, splitBalance, withRunningBalance } from './ledger';
import { assertCanDecide, assertWithinLimit, lineReductions, resolveAdjustmentAmount, suggestSiblingDiscounts } from './adjustments';
import { ageBalance, currentAndArrears } from './aging';
import { assertEditable, assertTransition, canTransition, pickStructure, planInvoiceLines, totalOf, validateLines } from './fee-structures';
import { expectedByMethod, variance } from './cash-up';
import { checkSequence, docNumber } from './sequence';
import { PAYMENT_METHODS } from './types';

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : 'OTHER'; }
  return undefined;
};

describe('payment references', () => {
  it('normalises method:UPPER(ref) without spaces', () => {
    expect(referenceKey('momo_mtn', '  61 234 567 890 ')).toBe('momo_mtn:61234567890');
    expect(referenceKey('bank_transfer', 'gcb-abc\t12')).toBe('bank_transfer:GCB-ABC12');
    expect(referenceKey('cash', '   ')).toBeNull();
    expect(referenceKey('cash', null)).toBeNull();
    expect(cleanReference(' a b ')).toBe('AB');
  });

  it('requires a reference for every method except cash', () => {
    for (const m of PAYMENT_METHODS) {
      expect(requiresReference(m)).toBe(m !== 'cash');
      expect(methodLabel(m)).toBeTruthy();
    }
    expect(validateReference('cash', undefined)).toBeNull();
    expect(validateReference('cash', ' x1 ')).toBe('X1');
    expect(code(() => validateReference('momo_mtn', ' '))).toBe('422:PAYMENT_REFERENCE_REQUIRED');
    expect(code(() => validateReference('cheque', null))).toBe('422:PAYMENT_REFERENCE_REQUIRED');
  });

  it('property: key is idempotent under whitespace and case changes', () => {
    fc.assert(fc.property(fc.constantFrom(...PAYMENT_METHODS), fc.stringMatching(/^[A-Za-z0-9 -]{1,20}$/), (m, ref) => {
      expect(referenceKey(m, ` ${ref.toLowerCase()} `)).toBe(referenceKey(m, ref.toUpperCase()));
    }));
  });
});

describe('ledger maths', () => {
  it('signs: + owed, − paid/credited', () => {
    expect(chargeEntry(500)).toBe(500);
    expect(paymentEntry(500)).toBe(-500);
    expect(adjustmentEntry('discount', 100)).toBe(-100);
    expect(adjustmentEntry('write_off', 100)).toBe(-100);
    expect(adjustmentEntry('manual_charge', 100)).toBe(100);
    expect(adjustmentEntry('refund', 100)).toBe(100);
    expect(reversalEntry(-500)).toBe(500);
    expect(reversalEntry(0)).toBe(0);
    expect(isCreditAdjustment('sibling_discount')).toBe(true);
    expect(() => paymentEntry(0)).toThrow(RangeError);
    expect(() => chargeEntry(-1)).toThrow(RangeError);
  });

  it('balance and running balance', () => {
    const e = [{ amountPesewas: 1000 }, { amountPesewas: -400 }, { amountPesewas: -700 }];
    expect(balanceOf(e)).toBe(-100);
    expect(withRunningBalance(e).map((x) => x.runningBalancePesewas)).toEqual([1000, 600, -100]);
    expect(splitBalance(-100)).toEqual({ owedPesewas: 0, creditPesewas: 100 });
    expect(splitBalance(250)).toEqual({ owedPesewas: 250, creditPesewas: 0 });
  });
});

describe('adjustments', () => {
  it('amount or basis points via percentOf (half-up)', () => {
    expect(resolveAdjustmentAmount({ amountPesewas: 500 }, 0)).toBe(500);
    expect(resolveAdjustmentAmount({ percentBasisPoints: 2500 }, 100_001)).toBe(25_000);
    expect(resolveAdjustmentAmount({ percentBasisPoints: 1 }, 5_000)).toBe(1); // 0.5 → 1
    expect(code(() => resolveAdjustmentAmount({}, 100))).toBe('400:VALIDATION_FAILED');
    expect(code(() => resolveAdjustmentAmount({ amountPesewas: 1, percentBasisPoints: 1 }, 100))).toBe('400:VALIDATION_FAILED');
    expect(code(() => resolveAdjustmentAmount({ amountPesewas: 0 }, 100))).toBe('400:VALIDATION_FAILED');
    expect(code(() => resolveAdjustmentAmount({ percentBasisPoints: 10001 }, 100))).toBe('400:VALIDATION_FAILED');
    expect(code(() => resolveAdjustmentAmount({ percentBasisPoints: 100 }, 0))).toBe('422:ADJUSTMENT_INVALID_STATE');
  });

  it('maker-checker: no self-approval, admin-only types, state', () => {
    const head = { id: 'h', roles: ['HEADTEACHER'] };
    const admin = { id: 'a', roles: ['ADMIN'] };
    expect(code(() => assertCanDecide({ status: 'pending', requestedBy: 'h', type: 'discount' }, head))).toBe('403:ADJUSTMENT_SELF_APPROVAL');
    expect(code(() => assertCanDecide({ status: 'pending', requestedBy: 'b', type: 'refund' }, head))).toBe('403:FORBIDDEN');
    expect(code(() => assertCanDecide({ status: 'pending', requestedBy: 'b', type: 'write_off' }, admin))).toBeUndefined();
    expect(code(() => assertCanDecide({ status: 'pending', requestedBy: 'b', type: 'discount' }, head))).toBeUndefined();
    expect(code(() => assertCanDecide({ status: 'approved', requestedBy: 'b', type: 'discount' }, head))).toBe('409:ADJUSTMENT_INVALID_STATE');
    expect(code(() => assertCanDecide({ status: 'pending', requestedBy: 'x', type: 'discount' }, { id: 'b', roles: ['BURSAR'] }))).toBe('403:FORBIDDEN');
  });

  it('limits', () => {
    expect(code(() => assertWithinLimit('discount', 101, { targetOwedPesewas: 100, creditPesewas: 0 }))).toBe('422:ADJUSTMENT_INVALID_STATE');
    expect(code(() => assertWithinLimit('refund', 101, { targetOwedPesewas: 0, creditPesewas: 100 }))).toBe('422:ADJUSTMENT_INVALID_STATE');
    expect(code(() => assertWithinLimit('refund', 100, { targetOwedPesewas: 0, creditPesewas: 100 }))).toBeUndefined();
    expect(code(() => assertWithinLimit('manual_charge', 10 ** 9, { targetOwedPesewas: 0, creditPesewas: 0 }))).toBeUndefined();
  });

  it('line reductions: fee item first, otherwise last-paid line first, capped', () => {
    const lines = [
      { invoiceLineId: 'tuition', feeItemId: 'T', amountPesewas: 1000, allocationPriority: 1, sequence: 1 },
      { invoiceLineId: 'feeding', feeItemId: 'F', amountPesewas: 300, allocationPriority: 5, sequence: 2 },
    ];
    expect(Object.fromEntries(lineReductions(lines, [{ feeItemId: 'T', creditPesewas: 200 }]))).toEqual({ tuition: 200, feeding: 0 });
    expect(Object.fromEntries(lineReductions(lines, [{ feeItemId: null, creditPesewas: 500 }]))).toEqual({ tuition: 200, feeding: 300 });
    expect(Object.fromEntries(lineReductions(lines, [{ feeItemId: 'F', creditPesewas: 999 }, { feeItemId: null, creditPesewas: 0 }]))).toEqual({ tuition: 0, feeding: 300 });
  });

  it('sibling discount suggestions skip the eldest', () => {
    const s = suggestSiblingDiscounts([
      { studentId: 'young', dateOfBirth: '2019-04-01', tuitionPesewas: 100_000 },
      { studentId: 'old', dateOfBirth: '2014-04-01', tuitionPesewas: 120_000 },
      { studentId: 'mid', dateOfBirth: '2016-04-01', tuitionPesewas: 0 },
    ], { basisPoints: 1000, minChildren: 2 });
    expect(s).toEqual([{ studentId: 'young', basisPoints: 1000, amountPesewas: 10_000 }]);
    expect(suggestSiblingDiscounts([{ studentId: 'a', dateOfBirth: '2019-01-01', tuitionPesewas: 1 }], { basisPoints: 1000, minChildren: 2 })).toEqual([]);
  });
});

describe('aging', () => {
  const charges = [
    { termId: 't1', termIndex: 1, chargedPesewas: 1000 },
    { termId: 't2', termIndex: 2, chargedPesewas: 1000 },
    { termId: 't3', termIndex: 3, chargedPesewas: 1000 },
    { termId: 't4', termIndex: 4, chargedPesewas: 1000 },
    { termId: 't5', termIndex: 5, chargedPesewas: 1000 },
  ];
  it('puts what is owed into the newest terms', () => {
    expect(ageBalance(1500, charges, 5)).toEqual({ currentPesewas: 1000, oneTermPesewas: 500, twoTermsPesewas: 0, threePlusTermsPesewas: 0, totalPesewas: 1500 });
    expect(ageBalance(5600, charges, 5)).toEqual({ currentPesewas: 1000, oneTermPesewas: 1000, twoTermsPesewas: 1000, threePlusTermsPesewas: 2600, totalPesewas: 5600 });
    expect(ageBalance(-50, charges, 5).totalPesewas).toBe(0);
    expect(currentAndArrears(ageBalance(1500, charges, 5))).toEqual({ currentTermOutstandingPesewas: 1000, arrearsPesewas: 500 });
  });
  it('property: buckets sum to the owed balance', () => {
    fc.assert(fc.property(fc.integer({ min: -10_000, max: 100_000 }), fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 8 }), (bal, cs) => {
      const b = ageBalance(bal, cs.map((c, i) => ({ termId: `t${i}`, termIndex: i, chargedPesewas: c })), cs.length - 1);
      expect(b.currentPesewas + b.oneTermPesewas + b.twoTermsPesewas + b.threePlusTermsPesewas).toBe(Math.max(0, bal));
    }));
  });
});

describe('fee structures', () => {
  it('draft → active → retired only', () => {
    expect(canTransition('draft', 'active')).toBe(true);
    expect(canTransition('active', 'retired')).toBe(true);
    expect(canTransition('active', 'draft')).toBe(false);
    expect(canTransition('retired', 'active')).toBe(false);
    expect(code(() => assertTransition('retired', 'active'))).toBe('409:FEE_STRUCTURE_IMMUTABLE');
    expect(code(() => assertEditable('active'))).toBe('422:FEE_STRUCTURE_IMMUTABLE');
    expect(code(() => assertEditable('draft'))).toBeUndefined();
  });
  it('validates lines', () => {
    expect(code(() => validateLines([{ feeItemId: 'a', amountPesewas: 1 }, { feeItemId: 'a', amountPesewas: 2 }]))).toBe('400:VALIDATION_FAILED');
    expect(code(() => validateLines([{ feeItemId: 'a', amountPesewas: -1 }]))).toBe('400:VALIDATION_FAILED');
    expect(code(() => validateLines([{ feeItemId: 'a', amountPesewas: 1.5 }]))).toBe('400:VALIDATION_FAILED');
  });
  it('plans invoice lines with optional opt-ins', () => {
    const s = [
      { feeItemId: 'T', feeItemName: 'Tuition', amountPesewas: 100_000, isOptional: false, allocationPriority: 1 },
      { feeItemId: 'B', feeItemName: 'Bus', amountPesewas: 30_000, isOptional: true, allocationPriority: 5 },
      { feeItemId: 'F', feeItemName: 'Feeding', amountPesewas: 40_000, isOptional: true, allocationPriority: 4 },
      { feeItemId: 'Z', feeItemName: 'Zero', amountPesewas: 0, isOptional: false, allocationPriority: 9 },
    ];
    const lines = planInvoiceLines(s, new Set(['B']));
    expect(lines.map((l) => l.feeItemId)).toEqual(['T', 'B']);
    expect(totalOf(lines)).toBe(130_000);
  });
  it('class override beats level structure', () => {
    const active = [{ id: 'lvl', classId: null, levelId: 'P1' }, { id: 'cls', classId: 'P1A', levelId: 'P1' }];
    expect(pickStructure(active, { classId: 'P1A', levelId: 'P1' })!.id).toBe('cls');
    expect(pickStructure(active, { classId: 'P1B', levelId: 'P1' })!.id).toBe('lvl');
    expect(pickStructure(active, { classId: null, levelId: null })).toBeNull();
    expect(pickStructure(active, { classId: 'X', levelId: 'P2' })).toBeNull();
  });
});

describe('cash-up', () => {
  it('expected and variance by method', () => {
    const exp = expectedByMethod([
      { method: 'cash', amountPesewas: 1000, status: 'confirmed' },
      { method: 'cash', amountPesewas: 500, status: 'reversed' },
      { method: 'momo_mtn', amountPesewas: 2000, status: 'confirmed' },
    ]);
    expect(exp.cash).toBe(1000);
    expect(exp.momo_mtn).toBe(2000);
    const v = variance(exp, { cash: 900, momo_mtn: 2000 });
    expect(v.byMethod.cash).toBe(-100);
    expect(v.totalPesewas).toBe(-100);
    expect(() => variance(exp, { cash: 1.5 })).toThrow(RangeError);
  });
  it('treats methods missing from stored expected totals as zero (sparse JSON from a closed cash-up)', () => {
    const v = variance({ cash: 641000, momo_mtn: 102000 }, { cash: 641000, momo_mtn: 100000, at_money: 500 });
    expect(v.byMethod).toMatchObject({ cash: 0, momo_mtn: -2000, at_money: 500, cheque: 0 });
    expect(v.totalPesewas).toBe(-1500);
  });
});

describe('receipt sequence check', () => {
  it('finds gaps and duplicates', () => {
    expect(docNumber('RCP-000413')).toBe(413);
    expect(docNumber('nope')).toBeNull();
    const r = checkSequence(['RCP-000001', 'RCP-000002', 'RCP-000005', 'RCP-000005', 'bad', 'RCP-000003']);
    expect(r.gaps).toEqual([{ from: 4, to: 4 }]);
    expect(r.duplicates).toEqual(['RCP-000005']);
    expect(r.unparseable).toEqual(['bad']);
    expect(r.first).toBe(1);
    expect(r.last).toBe(5);
    expect(checkSequence(['RCP-3'], 1).gaps).toEqual([{ from: 1, to: 2 }]);
    expect(checkSequence([]).gaps).toEqual([]);
  });
});
