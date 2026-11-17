import { assertPesewas, type Pesewas } from '@sms/shared';

export interface TermCharge {
  termId: string;
  /** Position in the school calendar: larger = later term (e.g. year*10 + term number). */
  termIndex: number;
  /** Net amount charged for the term (charges minus credit adjustments; may be 0). */
  chargedPesewas: Pesewas;
}

export interface AgingBuckets {
  currentPesewas: Pesewas;
  oneTermPesewas: Pesewas;
  twoTermsPesewas: Pesewas;
  threePlusTermsPesewas: Pesewas;
  /** Owed that cannot be traced to a term (e.g. opening balances). Counted as oldest (3+). */
  totalPesewas: Pesewas;
}

/**
 * Ages a student's balance. Payments are applied oldest term first, so whatever is still owed sits in the newest terms:
 * walk back from the newest term, giving each term at most what it charged. Anything left over (opening balance) is 3+.
 * `termsBack(term)` = number of terms between the term and the current term (0 = current term).
 */
export function ageBalance(balance: Pesewas, charges: readonly TermCharge[], currentTermIndex: number, termsBack: (termIndex: number) => number = (i) => currentTermIndex - i): AgingBuckets {
  assertPesewas(balance);
  const out: AgingBuckets = { currentPesewas: 0, oneTermPesewas: 0, twoTermsPesewas: 0, threePlusTermsPesewas: 0, totalPesewas: Math.max(0, balance) };
  if (balance <= 0) return out;
  let remaining = balance;
  const newestFirst = [...charges].filter((c) => c.chargedPesewas > 0).sort((a, b) => b.termIndex - a.termIndex);
  for (const c of newestFirst) {
    if (remaining === 0) break;
    const take = Math.min(remaining, c.chargedPesewas);
    remaining -= take;
    addToBucket(out, Math.max(0, termsBack(c.termIndex)), take);
  }
  if (remaining > 0) out.threePlusTermsPesewas += remaining;
  return out;
}

function addToBucket(b: AgingBuckets, back: number, amount: Pesewas): void {
  if (back === 0) b.currentPesewas += amount;
  else if (back === 1) b.oneTermPesewas += amount;
  else if (back === 2) b.twoTermsPesewas += amount;
  else b.threePlusTermsPesewas += amount;
}

/** Current-term outstanding and arrears (everything older) for the Balance contract. */
export function currentAndArrears(buckets: AgingBuckets): { currentTermOutstandingPesewas: Pesewas; arrearsPesewas: Pesewas } {
  return {
    currentTermOutstandingPesewas: buckets.currentPesewas,
    arrearsPesewas: buckets.oneTermPesewas + buckets.twoTermsPesewas + buckets.threePlusTermsPesewas,
  };
}
