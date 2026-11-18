// Owner: Agent B. Withdrawal clearance checklist (stored as jsonb on withdrawals.clearance).
import type { AuthUser } from '../../security/auth-user';

export const CLEARANCE_ITEMS = ['fees', 'books', 'uniform', 'property', 'library'] as const;
export type ClearanceItem = (typeof CLEARANCE_ITEMS)[number];

export interface ClearanceEntry {
  cleared: boolean;
  /** true = not applicable to this student (counts as cleared). */
  notApplicable?: boolean;
  note?: string | null;
  byUserId?: string | null;
  byName?: string | null;
  at?: string | null;
  /** fees only: balance shown to the clearer at the time (pesewas). */
  balancePesewas?: number | null;
}

export type Clearance = Record<ClearanceItem, ClearanceEntry>;

export function emptyClearance(): Clearance {
  return Object.fromEntries(CLEARANCE_ITEMS.map((i) => [i, { cleared: false }])) as Clearance;
}

/** Normalises whatever is stored (older rows may miss items). */
export function readClearance(raw: unknown): Clearance {
  const base = emptyClearance();
  if (raw && typeof raw === 'object') {
    for (const item of CLEARANCE_ITEMS) {
      const v = (raw as Record<string, unknown>)[item];
      if (v && typeof v === 'object') base[item] = { ...base[item], ...(v as ClearanceEntry) };
    }
  }
  return base;
}

/** Fees clearance is a finance decision: only BURSAR or ADMIN may set it. */
export function canSetItem(item: ClearanceItem, user: Pick<AuthUser, 'roles'>): boolean {
  if (item !== 'fees') return true;
  return user.roles.includes('BURSAR') || user.roles.includes('ADMIN');
}

export function outstandingItems(c: Clearance): ClearanceItem[] {
  return CLEARANCE_ITEMS.filter((i) => !c[i].cleared && !c[i].notApplicable);
}

export function isFullyCleared(c: Clearance): boolean {
  return outstandingItems(c).length === 0;
}

export const CLEARANCE_LABELS: Record<ClearanceItem, string> = {
  fees: 'Fees', books: 'Books', uniform: 'Uniform', property: 'School property', library: 'Library',
};
