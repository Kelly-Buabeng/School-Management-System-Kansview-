import { describe, expect, it } from 'vitest';
import { addPesewas, allocateProportionally, formatCedis, parseCedis, percentOf } from './money';
import { dammCheckDigit, dammValidate, formatStudentCode, isValidStudentCode } from './damm';
import { normaliseGhanaPhone, maskPhone } from './phone';
import { ageOn, isIsoDate, todayInAccra } from './dates';

describe('money', () => {
  it('parses and formats cedis without floats', () => {
    expect(parseCedis('1,250.5')).toBe(125050);
    expect(parseCedis('GH₵ 20')).toBe(2000);
    expect(parseCedis('0.07')).toBe(7);
    expect(() => parseCedis('1.234')).toThrow();
    expect(() => parseCedis('abc')).toThrow();
    expect(formatCedis(125050)).toBe('GH₵ 1,250.50');
    expect(formatCedis(-5)).toBe('-GH₵ 0.05');
  });
  it('rejects non-integer amounts', () => {
    expect(() => addPesewas(1, 0.5)).toThrow();
  });
  it('computes percentages with half-up rounding', () => {
    expect(percentOf(100000, 2500)).toBe(25000);
    expect(percentOf(333, 5000)).toBe(167);
  });
  it('allocates proportionally and always sums exactly', () => {
    const parts = allocateProportionally(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('damm and student code', () => {
  it('matches the reference example', () => {
    expect(dammCheckDigit('572')).toBe(4);
    expect(dammValidate('5724')).toBe(true);
  });
  it('formats and validates student codes', () => {
    const code = formatStudentCode('KSV', 2026, 417);
    expect(code).toMatch(/^KSV-26-00417-\d$/);
    expect(isValidStudentCode(code)).toBe(true);
  });
  it('detects every single-digit error and adjacent swap', () => {
    const code = formatStudentCode('KSV', 2026, 417);
    const digits = code.replace(/\D/g, '');
    for (let i = 0; i < digits.length; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === digits[i]) continue;
        const bad = digits.slice(0, i) + d + digits.slice(i + 1);
        expect(dammValidate(bad)).toBe(false);
      }
      if (i < digits.length - 1 && digits[i] !== digits[i + 1]) {
        const swapped = digits.slice(0, i) + digits[i + 1] + digits[i] + digits.slice(i + 2);
        expect(dammValidate(swapped)).toBe(false);
      }
    }
  });
});

describe('phone', () => {
  it('normalises Ghana numbers', () => {
    expect(normaliseGhanaPhone('024 123 4567')).toBe('+233241234567');
    expect(normaliseGhanaPhone('+233-20-123-4567')).toBe('+233201234567');
    expect(normaliseGhanaPhone('12345')).toBeNull();
    expect(maskPhone('+233241234567')).toBe('+233*****4567');
  });
});

describe('dates', () => {
  it('handles ISO dates and ages', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(ageOn('2015-11-18', '2026-11-17')).toBe(10);
    expect(todayInAccra(new Date('2026-11-17T23:30:00Z'))).toBe('2026-11-17');
  });
});
