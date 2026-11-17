// Owner: Agent B. Pure score, grade and position logic (no DB). Scores are numeric(5,2), not money.

export interface GradingBand {
  minScore: number;
  maxScore: number;
  grade: string;
  remark: string | null;
}

export interface Weights {
  /** Percent of the final total coming from class work (e.g. 30). */
  classScoreWeight: number;
  /** Percent of the final total coming from the exam (e.g. 70). */
  examScoreWeight: number;
}

/** Round half away from zero to 2 decimal places without float drift (works on hundredths as integers). */
export function round2(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
}

/**
 * Class score and exam score are entered out of their weights (e.g. class /30, exam /70) as in most Ghanaian basic schools,
 * so the total is a plain sum capped at 100. Null when nothing has been entered yet.
 */
export function computeTotal(classScore: number | null, examScore: number | null, w: Weights): number | null {
  if (classScore === null && examScore === null) return null;
  const c = classScore ?? 0;
  const e = examScore ?? 0;
  if (c < 0 || c > w.classScoreWeight) throw new RangeError(`Class score must be between 0 and ${w.classScoreWeight}`);
  if (e < 0 || e > w.examScoreWeight) throw new RangeError(`Exam score must be between 0 and ${w.examScoreWeight}`);
  return round2(c + e);
}

export function validateWeights(w: Weights): void {
  if (w.classScoreWeight < 0 || w.examScoreWeight < 0 || round2(w.classScoreWeight + w.examScoreWeight) !== 100) {
    throw new RangeError('Class and exam weights must add up to 100');
  }
}

/** Bands must not overlap; scores are compared with 2-decimal precision. */
export function validateBands(bands: GradingBand[]): string | null {
  if (bands.length === 0) return 'A grading scale needs at least one band';
  const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
  for (const b of sorted) {
    if (b.minScore > b.maxScore) return `Band ${b.grade}: the minimum is above the maximum`;
    if (b.minScore < 0 || b.maxScore > 100) return `Band ${b.grade}: scores must be between 0 and 100`;
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.minScore <= sorted[i - 1]!.maxScore) return `Bands ${sorted[i - 1]!.grade} and ${sorted[i]!.grade} overlap`;
  }
  const grades = new Set(bands.map((b) => b.grade));
  if (grades.size !== bands.length) return 'Each band needs a different grade';
  return null;
}

/**
 * Finds the band for a total: the highest band whose minimum is at or below the total.
 * So with bands 70–79 and 80–100 a total of 79.5 (between the bands) gets the 70–79 grade.
 */
export function gradeFor(total: number | null, bands: GradingBand[]): GradingBand | null {
  if (total === null) return null;
  const sorted = [...bands].sort((a, b) => b.minScore - a.minScore);
  return sorted.find((b) => total >= b.minScore) ?? null;
}

export interface Ranked<T> {
  item: T;
  position: number;
  tied: boolean;
}

/**
 * Standard competition ranking ("1, 2, 2, 4"): equal scores share a position and the next position is skipped.
 * Items with a null score are not ranked (position null) and listed last.
 */
export function rankWithTies<T>(items: T[], score: (t: T) => number | null): Array<{ item: T; position: number | null; tied: boolean }> {
  const scored = items.filter((i) => score(i) !== null).sort((a, b) => score(b)! - score(a)!);
  const counts = new Map<number, number>();
  for (const s of scored) counts.set(round2(score(s)!), (counts.get(round2(score(s)!)) ?? 0) + 1);
  const out: Array<{ item: T; position: number | null; tied: boolean }> = [];
  let prev: number | null = null;
  let prevPos = 0;
  scored.forEach((it, idx) => {
    const s = round2(score(it)!);
    const pos = prev !== null && s === prev ? prevPos : idx + 1;
    prev = s;
    prevPos = pos;
    out.push({ item: it, position: pos, tied: (counts.get(s) ?? 0) > 1 });
  });
  for (const it of items) if (score(it) === null) out.push({ item: it, position: null, tied: false });
  return out;
}

export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "3rd", or "joint 3rd" when tied. */
export function positionLabel(position: number | null, tied: boolean): string | null {
  if (position === null) return null;
  return tied ? `joint ${ordinal(position)}` : ordinal(position);
}
