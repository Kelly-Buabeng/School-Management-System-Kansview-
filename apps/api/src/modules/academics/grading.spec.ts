import { describe, expect, it } from 'vitest';
import { computeTotal, gradeFor, ordinal, positionLabel, rankWithTies, round2, validateBands, validateWeights, type GradingBand } from './grading';

const bands: GradingBand[] = [
  { minScore: 80, maxScore: 100, grade: '1', remark: 'Highest' },
  { minScore: 70, maxScore: 79, grade: '2', remark: 'Higher' },
  { minScore: 60, maxScore: 69, grade: '3', remark: 'High' },
  { minScore: 0, maxScore: 59, grade: '4', remark: 'Lower' },
];

describe('grading', () => {
  it('computes totals from weighted parts', () => {
    expect(computeTotal(25.5, 60.25, { classScoreWeight: 30, examScoreWeight: 70 })).toBe(85.75);
    expect(computeTotal(null, 40, { classScoreWeight: 30, examScoreWeight: 70 })).toBe(40);
    expect(computeTotal(null, null, { classScoreWeight: 30, examScoreWeight: 70 })).toBeNull();
    expect(() => computeTotal(31, 0, { classScoreWeight: 30, examScoreWeight: 70 })).toThrow(/between 0 and 30/);
    expect(() => computeTotal(0, 71, { classScoreWeight: 30, examScoreWeight: 70 })).toThrow();
  });

  it('rounds to 2 dp without float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-2.345)).toBe(-2.35);
  });

  it('validates weights', () => {
    expect(() => validateWeights({ classScoreWeight: 30, examScoreWeight: 70 })).not.toThrow();
    expect(() => validateWeights({ classScoreWeight: 40, examScoreWeight: 70 })).toThrow();
  });

  it('finds the band, including gaps between bands', () => {
    expect(gradeFor(85, bands)?.grade).toBe('1');
    expect(gradeFor(80, bands)?.grade).toBe('1');
    expect(gradeFor(79.5, bands)?.grade).toBe('2');
    expect(gradeFor(0, bands)?.grade).toBe('4');
    expect(gradeFor(null, bands)).toBeNull();
  });

  it('rejects overlapping or duplicate bands', () => {
    expect(validateBands(bands)).toBeNull();
    expect(validateBands([...bands, { minScore: 75, maxScore: 85, grade: 'X', remark: null }])).toMatch(/overlap/);
    expect(validateBands([{ minScore: 50, maxScore: 40, grade: 'A', remark: null }])).toMatch(/minimum/);
    expect(validateBands([])).toMatch(/at least one/);
    expect(validateBands([{ minScore: 0, maxScore: 10, grade: 'A', remark: null }, { minScore: 11, maxScore: 20, grade: 'A', remark: null }])).toMatch(/different grade/);
  });

  it('ranks with ties (1, 2, 2, 4) and puts unscored last', () => {
    const r = rankWithTies(
      [{ n: 'a', s: 90 }, { n: 'b', s: 80 }, { n: 'c', s: null }, { n: 'd', s: 80 }, { n: 'e', s: 70 }],
      (x) => x.s,
    );
    expect(r.map((x) => [x.item.n, x.position, x.tied])).toEqual([
      ['a', 1, false], ['b', 2, true], ['d', 2, true], ['e', 4, false], ['c', null, false],
    ]);
  });

  it('labels positions', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
    expect(positionLabel(3, true)).toBe('joint 3rd');
    expect(positionLabel(1, false)).toBe('1st');
    expect(positionLabel(null, false)).toBeNull();
  });
});
