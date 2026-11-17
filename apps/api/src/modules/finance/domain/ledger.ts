import { addPesewas, assertPesewas, type Pesewas } from '@sms/shared';
import type { AdjustmentType, LedgerEntryType } from './types';

/**
 * Ledger sign convention (schema.md): + = owed by the family, − = paid or credited.
 * Balance = Σ amount_pesewas; a negative balance is credit held for the family.
 */
export interface LedgerAmount {
  entryType: LedgerEntryType;
  amountPesewas: Pesewas;
}

/** Adjustment types that reduce what the family owes. */
export const CREDIT_ADJUSTMENTS: readonly AdjustmentType[] = ['discount', 'scholarship', 'bursary', 'sibling_discount', 'waiver', 'write_off'];
/** Adjustment types that increase what the family owes (refund pays credit back out, so balance goes up). */
export const DEBIT_ADJUSTMENTS: readonly AdjustmentType[] = ['manual_charge', 'refund'];

export function isCreditAdjustment(type: AdjustmentType): boolean {
  return CREDIT_ADJUSTMENTS.includes(type);
}

/** Signed ledger amount for an invoice line charge. */
export function chargeEntry(amount: Pesewas): Pesewas {
  assertPositiveOrZero(amount);
  return amount;
}

/** Signed ledger amount for a payment. */
export function paymentEntry(amount: Pesewas): Pesewas {
  assertPositive(amount);
  return -amount;
}

/** Signed ledger amount for an approved adjustment (amount is the positive size of the adjustment). */
export function adjustmentEntry(type: AdjustmentType, amount: Pesewas): Pesewas {
  assertPositive(amount);
  return isCreditAdjustment(type) ? -amount : amount;
}

/** Signed ledger amount that cancels an earlier entry. */
export function reversalEntry(original: Pesewas): Pesewas {
  assertPesewas(original);
  return original === 0 ? 0 : -original;
}

export function balanceOf(entries: readonly { amountPesewas: Pesewas }[]): Pesewas {
  return addPesewas(0, ...entries.map((e) => e.amountPesewas));
}

export interface RunningEntry<T> {
  entry: T;
  runningBalancePesewas: Pesewas;
}

/** Adds a running balance to entries already sorted in posting order. */
export function withRunningBalance<T extends { amountPesewas: Pesewas }>(entries: readonly T[], opening: Pesewas = 0): Array<T & { runningBalancePesewas: Pesewas }> {
  let running = opening;
  return entries.map((e) => {
    running = addPesewas(running, e.amountPesewas);
    return { ...e, runningBalancePesewas: running };
  });
}

/** Splits a signed balance into owed and credit parts. */
export function splitBalance(balance: Pesewas): { owedPesewas: Pesewas; creditPesewas: Pesewas } {
  assertPesewas(balance);
  return balance >= 0 ? { owedPesewas: balance, creditPesewas: 0 } : { owedPesewas: 0, creditPesewas: -balance };
}

function assertPositive(v: Pesewas): void {
  assertPesewas(v);
  if (v <= 0) throw new RangeError('amount must be more than zero');
}
function assertPositiveOrZero(v: Pesewas): void {
  assertPesewas(v);
  if (v < 0) throw new RangeError('amount must not be negative');
}
