export interface SequenceCheck {
  count: number;
  first: number | null;
  last: number | null;
  /** Missing numbers as inclusive ranges. */
  gaps: Array<{ from: number; to: number }>;
  duplicates: string[];
  unparseable: string[];
}

/** Trailing number of a document number: "RCP-000413" → 413. */
export function docNumber(docNo: string): number | null {
  const m = /(\d+)\s*$/.exec(docNo);
  return m ? Number(m[1]) : null;
}

/**
 * Checks that document numbers (receipts) form a continuous run with no gaps or duplicates.
 * When `expectedFirst` is given the check also flags numbers missing before the first one seen.
 */
export function checkSequence(docNos: readonly string[], expectedFirst?: number): SequenceCheck {
  const nums: number[] = [];
  const seen = new Set<number>();
  const duplicates: string[] = [];
  const unparseable: string[] = [];
  for (const d of docNos) {
    const n = docNumber(d);
    if (n === null) {
      unparseable.push(d);
      continue;
    }
    if (seen.has(n)) duplicates.push(d);
    else {
      seen.add(n);
      nums.push(n);
    }
  }
  nums.sort((a, b) => a - b);
  const gaps: Array<{ from: number; to: number }> = [];
  let prev = expectedFirst !== undefined ? expectedFirst - 1 : nums.length > 0 ? nums[0]! - 1 : 0;
  for (const n of nums) {
    if (n > prev + 1) gaps.push({ from: prev + 1, to: n - 1 });
    prev = n;
  }
  return { count: docNos.length, first: nums[0] ?? null, last: nums[nums.length - 1] ?? null, gaps, duplicates, unparseable };
}
