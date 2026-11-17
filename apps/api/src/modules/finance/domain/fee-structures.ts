import { ErrorCodes, addPesewas, type Pesewas } from '@sms/shared';
import { AppError } from '../../../common/app-error';

export type FeeStructureStatus = 'draft' | 'active' | 'retired';

const TRANSITIONS: Record<FeeStructureStatus, readonly FeeStructureStatus[]> = {
  draft: ['active'],
  active: ['retired'],
  retired: [],
};

export function canTransition(from: FeeStructureStatus, to: FeeStructureStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: FeeStructureStatus, to: FeeStructureStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, ErrorCodes.FEE_STRUCTURE_IMMUTABLE, `A ${from} fee structure cannot be made ${to}`);
  }
}

/** Lines may only change while draft. */
export function assertEditable(status: FeeStructureStatus): void {
  if (status !== 'draft') {
    throw new AppError(422, ErrorCodes.FEE_STRUCTURE_IMMUTABLE, 'This fee structure can no longer be changed', 'It has been activated. Retire it and create a new one (you can copy it).');
  }
}

export interface StructureLine {
  feeItemId: string;
  feeItemName: string;
  amountPesewas: Pesewas;
  isOptional: boolean;
  allocationPriority: number;
}

export interface PlannedInvoiceLine {
  feeItemId: string;
  description: string;
  amountPesewas: Pesewas;
  allocationPriority: number;
}

/** Validates draft lines: one line per fee item, amounts ≥ 0 whole pesewas. */
export function validateLines(lines: readonly { feeItemId: string; amountPesewas: Pesewas }[]): void {
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (!Number.isSafeInteger(l.amountPesewas) || l.amountPesewas < 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Amounts must be whole pesewas and not negative.', [
        { field: `lines.${i}.amountPesewas`, code: 'INVALID', message: 'Amount must be zero or more' },
      ]);
    }
    if (seen.has(l.feeItemId)) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Each fee item can appear only once.', [
        { field: `lines.${i}.feeItemId`, code: 'DUPLICATE', message: 'This fee item is listed twice' },
      ]);
    }
    seen.add(l.feeItemId);
  });
}

/**
 * Invoice lines for one student: every compulsory line, plus optional lines the student opted into for the term.
 * Zero-amount lines are skipped.
 */
export function planInvoiceLines(structure: readonly StructureLine[], optedInFeeItemIds: ReadonlySet<string>): PlannedInvoiceLine[] {
  return structure
    .filter((l) => l.amountPesewas > 0 && (!l.isOptional || optedInFeeItemIds.has(l.feeItemId)))
    .map((l) => ({ feeItemId: l.feeItemId, description: l.feeItemName, amountPesewas: l.amountPesewas, allocationPriority: l.allocationPriority }));
}

export function totalOf(lines: readonly { amountPesewas: Pesewas }[]): Pesewas {
  return addPesewas(0, ...lines.map((l) => l.amountPesewas));
}

/** Picks the structure for a student: class override beats level structure. */
export function pickStructure<T extends { classId: string | null; levelId: string }>(active: readonly T[], student: { classId: string | null; levelId: string | null }): T | null {
  if (!student.levelId) return null;
  return active.find((s) => s.classId !== null && s.classId === student.classId) ?? active.find((s) => s.classId === null && s.levelId === student.levelId) ?? null;
}
