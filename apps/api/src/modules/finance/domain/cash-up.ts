import { addPesewas, assertPesewas, type Pesewas } from '@sms/shared';
import { PAYMENT_METHODS, type PaymentMethod } from './types';

export type ByMethod = Record<PaymentMethod, Pesewas>;

export function emptyByMethod(): ByMethod {
  return Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as ByMethod;
}

/** Expected takings by method from confirmed payments (reversed payments excluded). */
export function expectedByMethod(payments: readonly { method: PaymentMethod; amountPesewas: Pesewas; status: string }[]): ByMethod {
  const out = emptyByMethod();
  for (const p of payments) {
    if (p.status !== 'confirmed') continue;
    out[p.method] = addPesewas(out[p.method], p.amountPesewas);
  }
  return out;
}

export interface Variance {
  byMethod: ByMethod;
  /** Counted − expected over all methods. Positive = surplus, negative = shortage. */
  totalPesewas: Pesewas;
}

/** Variance = counted − expected per method. Methods not counted are treated as zero counted. */
export function variance(expected: ByMethod, counted: Partial<ByMethod>): Variance {
  const byMethod = emptyByMethod();
  let total = 0;
  for (const m of PAYMENT_METHODS) {
    const c = counted[m] ?? 0;
    assertPesewas(c);
    byMethod[m] = c - expected[m];
    total = addPesewas(total, byMethod[m]);
  }
  return { byMethod, totalPesewas: total };
}
