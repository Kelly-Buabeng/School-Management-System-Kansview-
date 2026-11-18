import { describe, expect, it } from 'vitest';
import { canSetItem, emptyClearance, isFullyCleared, outstandingItems, readClearance } from './clearance';

describe('withdrawal clearance', () => {
  it('starts with everything outstanding', () => {
    expect(outstandingItems(emptyClearance())).toEqual(['fees', 'books', 'uniform', 'property', 'library']);
  });
  it('counts not-applicable as cleared', () => {
    const c = emptyClearance();
    for (const k of ['fees', 'books', 'uniform', 'property'] as const) c[k] = { cleared: true };
    expect(isFullyCleared(c)).toBe(false);
    c.library = { cleared: false, notApplicable: true };
    expect(isFullyCleared(c)).toBe(true);
  });
  it('reads partial stored data', () => {
    const c = readClearance({ fees: { cleared: true, balancePesewas: 0 }, junk: 1 });
    expect(c.fees.cleared).toBe(true);
    expect(c.books.cleared).toBe(false);
    expect(readClearance(null).fees.cleared).toBe(false);
  });
  it('fees clearance needs BURSAR or ADMIN', () => {
    expect(canSetItem('fees', { roles: ['REGISTRAR'] })).toBe(false);
    expect(canSetItem('fees', { roles: ['BURSAR'] })).toBe(true);
    expect(canSetItem('fees', { roles: ['ADMIN'] })).toBe(true);
    expect(canSetItem('books', { roles: ['REGISTRAR'] })).toBe(true);
  });
});
