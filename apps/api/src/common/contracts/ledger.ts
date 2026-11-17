import type { Pesewas } from '@sms/shared';

export interface StudentBalance {
  studentId: string;
  /** Positive = family owes the school; negative = credit. */
  balancePesewas: Pesewas;
  currentTermOutstandingPesewas: Pesewas;
  arrearsPesewas: Pesewas;
  creditPesewas: Pesewas;
  lastPaymentAt: string | null;
}

/** Read-side finance API for other modules (promotion arrears check, withdrawal clearance, dashboard). Owner: Agent C. */
export interface LedgerService {
  balance(studentId: string, tx?: unknown): Promise<StudentBalance>;
  outstandingByStudent(studentIds: string[], tx?: unknown): Promise<Map<string, Pesewas>>;
  /** Totals for dashboard: billed, collected, outstanding for a term. */
  termCollectionSummary(termId: string): Promise<{ billedPesewas: Pesewas; collectedPesewas: Pesewas; outstandingPesewas: Pesewas }>;
}
export const LEDGER_SERVICE = Symbol('LEDGER_SERVICE');
