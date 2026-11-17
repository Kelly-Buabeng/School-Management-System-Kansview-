import { ErrorCodes, addPesewas, assertPesewas, type Pesewas } from '@sms/shared';
import { AppError } from '../../../common/app-error';
import type { Allocation, AllocationResult, OutstandingLine } from './types';

function cmp(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Oldest outstanding term first, then fee item allocation priority (lower first), then stable sequence. */
export function sortForAllocation(lines: readonly OutstandingLine[]): OutstandingLine[] {
  return [...lines].sort(
    (a, b) =>
      cmp(a.termKey, b.termKey) ||
      a.allocationPriority - b.allocationPriority ||
      cmp(a.sequence, b.sequence) ||
      cmp(a.invoiceLineId, b.invoiceLineId),
  );
}

/** Automatic allocation of `amount` to outstanding lines. Excess is returned as unallocated credit. */
export function autoAllocate(amount: Pesewas, lines: readonly OutstandingLine[]): AllocationResult {
  assertPesewas(amount);
  if (amount < 0) throw new RangeError('amount must not be negative');
  let remaining = amount;
  const allocations: Allocation[] = [];
  for (const line of sortForAllocation(lines)) {
    if (remaining === 0) break;
    assertPesewas(line.outstandingPesewas);
    if (line.outstandingPesewas <= 0) continue;
    const take = Math.min(remaining, line.outstandingPesewas);
    allocations.push({ invoiceLineId: line.invoiceLineId, amountPesewas: take });
    remaining -= take;
  }
  return { allocations, unallocatedPesewas: remaining };
}

/**
 * Validates explicit allocations chosen by the bursar.
 * Rules: every line must be outstanding for this student, each amount ≤ the line's outstanding, sum ≤ payment amount.
 * Repeated line ids are merged before checking.
 */
export function validateExplicitAllocations(amount: Pesewas, requested: readonly Allocation[], lines: readonly OutstandingLine[]): AllocationResult {
  assertPesewas(amount);
  const byLine = new Map(lines.map((l) => [l.invoiceLineId, l]));
  const merged = new Map<string, Pesewas>();
  for (const r of requested) {
    assertPesewas(r.amountPesewas);
    if (r.amountPesewas <= 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Each allocation must be more than zero.', [
        { field: 'allocations', code: 'TOO_SMALL', message: 'Allocation amounts must be more than zero' },
      ]);
    }
    merged.set(r.invoiceLineId, addPesewas(merged.get(r.invoiceLineId) ?? 0, r.amountPesewas));
  }
  let total = 0;
  const allocations: Allocation[] = [];
  for (const [invoiceLineId, amt] of merged) {
    const line = byLine.get(invoiceLineId);
    if (!line) {
      throw new AppError(
        422,
        ErrorCodes.PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING,
        'This fee line cannot take this payment',
        'One of the chosen fee lines does not belong to this student or is already paid.',
        [{ field: 'allocations', code: 'UNKNOWN_LINE', message: `Fee line ${invoiceLineId} is not open for this student` }],
        { invoiceLineId },
      );
    }
    if (amt > line.outstandingPesewas) {
      throw new AppError(
        422,
        ErrorCodes.PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING,
        'Allocation is more than what is owed on the line',
        'One fee line was given more money than is still owed on it.',
        [{ field: 'allocations', code: 'EXCEEDS_OUTSTANDING', message: `Only ${line.outstandingPesewas} pesewas are owed on this line` }],
        { invoiceLineId, outstandingPesewas: line.outstandingPesewas, requestedPesewas: amt },
      );
    }
    total = addPesewas(total, amt);
    allocations.push({ invoiceLineId, amountPesewas: amt });
  }
  if (total > amount) {
    throw new AppError(
      422,
      ErrorCodes.PAYMENT_ALLOCATION_EXCEEDS_AMOUNT,
      'Allocations add up to more than the payment',
      'The amounts given to the fee lines add up to more than the money received.',
      [{ field: 'allocations', code: 'EXCEEDS_AMOUNT', message: 'Allocations exceed the payment amount' }],
      { amountPesewas: amount, allocatedPesewas: total },
    );
  }
  return { allocations, unallocatedPesewas: amount - total };
}

/** Allocates using explicit allocations if given, otherwise automatically. */
export function allocatePayment(amount: Pesewas, lines: readonly OutstandingLine[], explicit?: readonly Allocation[] | null): AllocationResult {
  if (explicit && explicit.length > 0) return validateExplicitAllocations(amount, explicit, lines);
  return autoAllocate(amount, lines);
}

/** A source of unallocated credit (a payment that still has money not tied to any line). */
export interface CreditSource {
  paymentId: string;
  /** Sort key: older payments are consumed first. */
  receivedAt: string;
  receiptNo: string;
  unallocatedPesewas: Pesewas;
}

export interface CreditApplication {
  paymentId: string;
  invoiceLineId: string;
  amountPesewas: Pesewas;
}

/**
 * Applies existing unallocated credit to outstanding lines (oldest credit first, lines in allocation order).
 * The caller persists, per application, a negative unallocated row and a positive line row in payment_allocations.
 * Credit cannot exceed what is owed, and the total applied never exceeds the total credit.
 */
export function applyCredit(sources: readonly CreditSource[], lines: readonly OutstandingLine[]): CreditApplication[] {
  const ordered = sortForAllocation(lines);
  const remainingByLine = new Map<string, Pesewas>();
  for (const l of ordered) remainingByLine.set(l.invoiceLineId, Math.max(0, l.outstandingPesewas));
  const out: CreditApplication[] = [];
  const sortedSources = [...sources].sort((a, b) => cmp(a.receivedAt, b.receivedAt) || cmp(a.receiptNo, b.receiptNo));
  for (const src of sortedSources) {
    assertPesewas(src.unallocatedPesewas);
    if (src.unallocatedPesewas <= 0) continue;
    const view = ordered.map((l) => ({ ...l, outstandingPesewas: remainingByLine.get(l.invoiceLineId) ?? 0 }));
    const { allocations } = autoAllocate(src.unallocatedPesewas, view);
    for (const a of allocations) {
      out.push({ paymentId: src.paymentId, invoiceLineId: a.invoiceLineId, amountPesewas: a.amountPesewas });
      remainingByLine.set(a.invoiceLineId, (remainingByLine.get(a.invoiceLineId) ?? 0) - a.amountPesewas);
    }
  }
  return out;
}

/** Outstanding of each line = line amount − Σ allocations (incl. negative reversal rows) − Σ line-level credits. */
export function lineOutstanding(lineAmount: Pesewas, allocated: readonly Pesewas[]): Pesewas {
  return lineAmount - addPesewas(0, ...allocated);
}

/** Caps credit sources (oldest first) so their total does not exceed `cap` (the family's ledger credit). */
export function capCreditSources(sources: readonly CreditSource[], cap: Pesewas): CreditSource[] {
  let left = Math.max(0, cap);
  const out: CreditSource[] = [];
  const sorted = [...sources].sort((a, b) => cmp(a.receivedAt, b.receivedAt) || cmp(a.receiptNo, b.receiptNo));
  for (const s of sorted) {
    if (left === 0) break;
    const take = Math.min(left, Math.max(0, s.unallocatedPesewas));
    if (take > 0) out.push({ ...s, unallocatedPesewas: take });
    left -= take;
  }
  return out;
}

export interface AllocationRow {
  /** null = unallocated credit. */
  invoiceLineId: string | null;
  amountPesewas: Pesewas;
}

/** Net amount per target (line id, or null for credit) from append-only allocation rows. Zero nets are dropped. */
export function netAllocations(rows: readonly AllocationRow[]): AllocationRow[] {
  const m = new Map<string | null, Pesewas>();
  for (const r of rows) m.set(r.invoiceLineId, addPesewas(m.get(r.invoiceLineId) ?? 0, r.amountPesewas));
  return [...m.entries()].filter(([, v]) => v !== 0).map(([invoiceLineId, amountPesewas]) => ({ invoiceLineId, amountPesewas }));
}

/** Rows that cancel a payment's allocations completely (used by reversal). */
export function reversalRows(rows: readonly AllocationRow[]): AllocationRow[] {
  return netAllocations(rows).map((r) => ({ invoiceLineId: r.invoiceLineId, amountPesewas: -r.amountPesewas }));
}

/**
 * Rows that move a payment from its current allocation to a new one (re-allocation by appending rows).
 * The new allocation must already be validated; any part of the payment not in `next` becomes credit.
 */
export function reallocationRows(current: readonly AllocationRow[], next: readonly Allocation[], paymentAmount: Pesewas): AllocationRow[] {
  const target = new Map<string | null, Pesewas>();
  let allocated = 0;
  for (const a of next) {
    target.set(a.invoiceLineId, addPesewas(target.get(a.invoiceLineId) ?? 0, a.amountPesewas));
    allocated = addPesewas(allocated, a.amountPesewas);
  }
  if (allocated > paymentAmount) throw new RangeError('re-allocation exceeds payment amount');
  if (paymentAmount - allocated > 0) target.set(null, paymentAmount - allocated);
  const now = new Map(netAllocations(current).map((r) => [r.invoiceLineId, r.amountPesewas] as const));
  const keys = new Set<string | null>([...now.keys(), ...target.keys()]);
  const out: AllocationRow[] = [];
  // negatives first so the running view never over-allocates
  for (const k of keys) {
    const d = (target.get(k) ?? 0) - (now.get(k) ?? 0);
    if (d < 0) out.push({ invoiceLineId: k, amountPesewas: d });
  }
  for (const k of keys) {
    const d = (target.get(k) ?? 0) - (now.get(k) ?? 0);
    if (d > 0) out.push({ invoiceLineId: k, amountPesewas: d });
  }
  return out;
}

export interface LineState {
  invoiceLineId: string;
  termKey: string | number;
  allocationPriority: number;
  sequence: string | number;
  /** Exact outstanding: amount − Σ allocations − adjustment reductions. Can be negative after a late discount. */
  outstandingPesewas: Pesewas;
  /** Net allocation per payment on this line, used to pull money back when the line is over-paid. */
  paidBy: readonly { paymentId: string; receivedAt: string; receiptNo: string; amountPesewas: Pesewas }[];
}

export interface CreditMove {
  paymentId: string;
  invoiceLineId: string | null;
  amountPesewas: Pesewas;
}

/**
 * Keeps the line-level "what is paid" view consistent with the ledger. Returns allocation rows to append.
 * 1. A line that is over-paid (e.g. a discount approved after payment) gives the excess back to credit, newest payment first.
 * 2. Free credit = Σ outstanding − ledger balance (credit not already used up by charges that have no invoice line,
 *    such as manual charges, opening balances or refunds), capped by the money actually unallocated.
 *    That credit is applied oldest payment first to the oldest outstanding lines.
 */
export function planCreditReconciliation(lines: readonly LineState[], sources: readonly CreditSource[], balance: Pesewas): CreditMove[] {
  const moves: CreditMove[] = [];
  const unalloc = new Map(sources.map((s) => [s.paymentId, { ...s }]));
  const outstanding: OutstandingLine[] = [];
  for (const l of lines) {
    let out = l.outstandingPesewas;
    if (out < 0) {
      let excess = -out;
      const newestFirst = [...l.paidBy].filter((p) => p.amountPesewas > 0).sort((a, b) => cmp(b.receivedAt, a.receivedAt) || cmp(b.receiptNo, a.receiptNo));
      for (const p of newestFirst) {
        if (excess === 0) break;
        const take = Math.min(excess, p.amountPesewas);
        moves.push({ paymentId: p.paymentId, invoiceLineId: l.invoiceLineId, amountPesewas: -take });
        moves.push({ paymentId: p.paymentId, invoiceLineId: null, amountPesewas: take });
        const src = unalloc.get(p.paymentId) ?? { paymentId: p.paymentId, receivedAt: p.receivedAt, receiptNo: p.receiptNo, unallocatedPesewas: 0 };
        src.unallocatedPesewas += take;
        unalloc.set(p.paymentId, src);
        excess -= take;
        out += take;
      }
    }
    outstanding.push({ invoiceLineId: l.invoiceLineId, termKey: l.termKey, allocationPriority: l.allocationPriority, sequence: l.sequence, outstandingPesewas: Math.max(0, out) });
  }
  const totalOutstanding = addPesewas(0, ...outstanding.map((o) => o.outstandingPesewas));
  const totalUnallocated = addPesewas(0, ...[...unalloc.values()].map((s) => Math.max(0, s.unallocatedPesewas)));
  const free = Math.min(totalUnallocated, Math.max(0, totalOutstanding - balance));
  if (free > 0) {
    for (const a of applyCredit(capCreditSources([...unalloc.values()], free), outstanding)) {
      moves.push({ paymentId: a.paymentId, invoiceLineId: null, amountPesewas: -a.amountPesewas });
      moves.push({ paymentId: a.paymentId, invoiceLineId: a.invoiceLineId, amountPesewas: a.amountPesewas });
    }
  }
  return moves;
}
