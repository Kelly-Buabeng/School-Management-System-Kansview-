import { ErrorCodes, assertPesewas, formatCedis, percentOf, type Pesewas } from '@sms/shared';
import { AppError } from '../../../common/app-error';
import { isCreditAdjustment } from './ledger';
import type { AdjustmentType } from './types';

export type AdjustmentStatus = 'pending' | 'approved' | 'rejected' | 'reversed';

/** Adjustment types that only an ADMIN may approve (money leaves the school or debt is cancelled). */
export const ADMIN_ONLY_ADJUSTMENTS: readonly AdjustmentType[] = ['refund', 'write_off'];

export interface AdjustmentAmountInput {
  amountPesewas?: Pesewas | null;
  percentBasisPoints?: number | null;
}

/**
 * Resolves the adjustment size. Exactly one of amount or basis points must be given.
 * Basis points are applied to `basePesewas` (the fee item line, or the term invoice total) with percentOf (half-up).
 */
export function resolveAdjustmentAmount(input: AdjustmentAmountInput, basePesewas: Pesewas): Pesewas {
  const hasAmount = input.amountPesewas != null;
  const hasPercent = input.percentBasisPoints != null;
  if (hasAmount === hasPercent) {
    throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Give either an amount or a percentage, not both.', [
      { field: 'amountPesewas', code: 'ONE_OF', message: 'Enter an amount or a percentage' },
    ]);
  }
  if (hasAmount) {
    assertPesewas(input.amountPesewas);
    if (input.amountPesewas! <= 0) throw badAmount('Amount must be more than zero');
    return input.amountPesewas!;
  }
  const bp = input.percentBasisPoints!;
  if (!Number.isSafeInteger(bp) || bp < 1 || bp > 10000) throw badAmount('Percentage must be between 0.01% and 100%');
  const amount = percentOf(basePesewas, bp);
  if (amount <= 0) {
    throw new AppError(422, ErrorCodes.ADJUSTMENT_INVALID_STATE, 'Nothing to adjust', 'The percentage works out to zero because nothing is billed for this item yet.');
  }
  return amount;
}

function badAmount(message: string): AppError {
  return new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', message, [{ field: 'amountPesewas', code: 'INVALID', message }]);
}

export interface Approver {
  id: string;
  roles: readonly string[];
}

/** Maker-checker rules for approving or rejecting an adjustment. */
export function assertCanDecide(adj: { status: AdjustmentStatus; requestedBy: string; type: AdjustmentType }, approver: Approver): void {
  if (adj.status !== 'pending') {
    throw new AppError(409, ErrorCodes.ADJUSTMENT_INVALID_STATE, 'This adjustment has already been decided', `It is ${adj.status}.`);
  }
  if (adj.requestedBy === approver.id) {
    throw new AppError(403, ErrorCodes.ADJUSTMENT_SELF_APPROVAL, 'You cannot approve your own request', 'Another person (headteacher or administrator) must approve it.');
  }
  if (ADMIN_ONLY_ADJUSTMENTS.includes(adj.type) && !approver.roles.includes('ADMIN')) {
    throw new AppError(403, ErrorCodes.FORBIDDEN, 'Only the administrator can approve this', 'Refunds and write-offs need the administrator.');
  }
  if (!approver.roles.includes('ADMIN') && !approver.roles.includes('HEADTEACHER')) {
    throw new AppError(403, ErrorCodes.FORBIDDEN, 'You do not have permission to do this');
  }
}

/**
 * Limits at posting time, so the ledger never shows nonsense:
 * - credit types (discount, waiver, write-off, …) cannot exceed what is still owed on the target;
 * - a refund cannot exceed the family's credit;
 * - a manual charge has no upper limit.
 */
export function assertWithinLimit(type: AdjustmentType, amount: Pesewas, ctx: { targetOwedPesewas: Pesewas; creditPesewas: Pesewas }): void {
  if (type === 'refund') {
    if (amount > ctx.creditPesewas) {
      throw new AppError(422, ErrorCodes.ADJUSTMENT_INVALID_STATE, 'Refund is more than the credit held', `The family has ${formatCedis(ctx.creditPesewas)} credit.`, undefined, {
        creditPesewas: ctx.creditPesewas,
      });
    }
    return;
  }
  if (isCreditAdjustment(type) && amount > ctx.targetOwedPesewas) {
    throw new AppError(422, ErrorCodes.ADJUSTMENT_INVALID_STATE, 'Adjustment is more than what is owed', `Only ${formatCedis(Math.max(0, ctx.targetOwedPesewas))} is still owed for this.`, undefined, {
      targetOwedPesewas: ctx.targetOwedPesewas,
    });
  }
}

export interface ReducibleLine {
  invoiceLineId: string;
  feeItemId: string;
  amountPesewas: Pesewas;
  allocationPriority: number;
  sequence: string | number;
}

/**
 * How much each invoice line is reduced by approved credit adjustments for the same term.
 * A fee-item adjustment reduces that item's line; otherwise lines are reduced in reverse payment order
 * (the line that would be paid last is reduced first). Reductions never exceed the line amount.
 */
export function lineReductions(lines: readonly ReducibleLine[], adjustments: readonly { feeItemId: string | null; creditPesewas: Pesewas }[]): Map<string, Pesewas> {
  const out = new Map<string, Pesewas>(lines.map((l) => [l.invoiceLineId, 0]));
  const reverseOrder = [...lines].sort((a, b) => b.allocationPriority - a.allocationPriority || cmp(b.sequence, a.sequence));
  for (const adj of adjustments) {
    let remaining = adj.creditPesewas;
    if (remaining <= 0) continue;
    const candidates = adj.feeItemId ? reverseOrder.filter((l) => l.feeItemId === adj.feeItemId) : reverseOrder;
    for (const l of candidates) {
      if (remaining === 0) break;
      const room = l.amountPesewas - (out.get(l.invoiceLineId) ?? 0);
      if (room <= 0) continue;
      const take = Math.min(room, remaining);
      out.set(l.invoiceLineId, (out.get(l.invoiceLineId) ?? 0) + take);
      remaining -= take;
    }
  }
  return out;
}

function cmp(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export interface SiblingChild {
  studentId: string;
  dateOfBirth: string;
  /** Tuition billed for the term (base for the percentage). */
  tuitionPesewas: Pesewas;
}

export interface SiblingSuggestion {
  studentId: string;
  basisPoints: number;
  amountPesewas: Pesewas;
}

/**
 * Sibling discount suggestion: every child except the eldest gets `basisPoints` off tuition, when the family has at least
 * `minChildren` children. Suggestion only: it must still be requested and approved by a second person.
 */
export function suggestSiblingDiscounts(children: readonly SiblingChild[], policy: { basisPoints: number; minChildren: number }): SiblingSuggestion[] {
  if (children.length < policy.minChildren) return [];
  const byAge = [...children].sort((a, b) => (a.dateOfBirth < b.dateOfBirth ? -1 : a.dateOfBirth > b.dateOfBirth ? 1 : cmp(a.studentId, b.studentId)));
  return byAge
    .slice(1)
    .map((c) => ({ studentId: c.studentId, basisPoints: policy.basisPoints, amountPesewas: percentOf(c.tuitionPesewas, policy.basisPoints) }))
    .filter((s) => s.amountPesewas > 0);
}
