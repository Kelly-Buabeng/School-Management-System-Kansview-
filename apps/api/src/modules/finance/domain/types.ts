import type { Pesewas } from '@sms/shared';

/** Payment methods (DB enum). v1: every payment is recorded manually by the bursar. */
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'momo_mtn', 'telecel_cash', 'at_money'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ADJUSTMENT_TYPES = [
  'discount', 'scholarship', 'bursary', 'sibling_discount', 'waiver', 'refund', 'write_off', 'manual_charge',
] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export const LEDGER_ENTRY_TYPES = ['invoice_charge', 'payment', 'adjustment', 'reversal', 'opening_balance'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** An invoice line that can still receive money. */
export interface OutstandingLine {
  invoiceLineId: string;
  /** Sortable key for the term the line belongs to (term start date `YYYY-MM-DD`, or a number). Older = smaller. */
  termKey: string | number;
  /** fee_items.allocation_priority: lower number is paid first. */
  allocationPriority: number;
  /** Stable tie-break (e.g. invoice_no + line position). */
  sequence: string | number;
  outstandingPesewas: Pesewas;
}

export interface Allocation {
  invoiceLineId: string;
  amountPesewas: Pesewas;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Money not allocated to any line: becomes credit (payment_allocations row with invoice_line_id NULL). */
  unallocatedPesewas: Pesewas;
}
