/**
 * Money helpers. All money is integer pesewas (GH₵1 = 100 pesewas).
 * Never use floating point for money. Use these helpers instead of ad-hoc arithmetic.
 */
export type Pesewas = number;

const MAX = Number.MAX_SAFE_INTEGER;

export function assertPesewas(value: unknown, field = 'amount'): asserts value is Pesewas {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be a whole number of pesewas`);
  }
}

export function addPesewas(...values: Pesewas[]): Pesewas {
  let total = 0;
  for (const v of values) {
    assertPesewas(v);
    total += v;
    if (Math.abs(total) > MAX) throw new RangeError('amount out of range');
  }
  return total;
}

/** Parse a cedi string typed by a user ("1,250.5", "GH₵ 20") into pesewas without floats. */
export function parseCedis(input: string): Pesewas {
  const cleaned = input.replace(/GH₵|GHS|,|\s/gi, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new RangeError(`"${input}" is not a valid amount`);
  const [, sign, whole, frac = ''] = m;
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(value)) throw new RangeError('amount out of range');
  return sign ? -value : value;
}

/** Format pesewas for display: 125050 -> "GH₵ 1,250.50". */
export function formatCedis(pesewas: Pesewas, opts: { symbol?: boolean } = {}): string {
  assertPesewas(pesewas);
  const neg = pesewas < 0;
  const abs = Math.abs(pesewas);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100).toString().padStart(2, '0');
  const body = `${whole}.${frac}`;
  const prefix = opts.symbol === false ? '' : 'GH₵ ';
  return `${neg ? '-' : ''}${prefix}${body}`;
}

/**
 * Percentage of an amount using basis points (2500 = 25%), rounded half-up to the nearest pesewa.
 * Integer-only arithmetic.
 */
export function percentOf(pesewas: Pesewas, basisPoints: number): Pesewas {
  assertPesewas(pesewas);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new RangeError('basis points must be 0..10000');
  }
  const product = BigInt(pesewas) * BigInt(basisPoints);
  const q = product / 10000n;
  const r = product % 10000n;
  const rounded = r * 2n >= 10000n ? q + 1n : q;
  return Number(rounded);
}

/**
 * Split an amount into parts proportional to weights, distributing the remainder so parts always sum exactly.
 */
export function allocateProportionally(total: Pesewas, weights: number[]): Pesewas[] {
  assertPesewas(total);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => Math.floor((total * w) / sum));
  let remainder = total - raw.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % raw.length) {
    if (weights[i]! > 0) {
      raw[i]! += 1;
      remainder -= 1;
    }
  }
  return raw;
}
