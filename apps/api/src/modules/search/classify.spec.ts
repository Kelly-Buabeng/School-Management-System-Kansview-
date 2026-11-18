import { describe, expect, it } from 'vitest';
import { classifyQuery, escapeLike } from './classify';

describe('search query classification', () => {
  it('detects student codes and prefixes', () => {
    expect(classifyQuery('ksv-26-00417-7').codePrefix).toBe('KSV-26-00417-7');
    expect(classifyQuery('KSV-26').codePrefix).toBe('KSV-26');
    expect(classifyQuery('Kofi').codePrefix).toBeNull();
  });
  it('detects phones in local or international form', () => {
    expect(classifyQuery('024 000 0123').phone).toBe('+233240000123');
    expect(classifyQuery('+233200000999').phone).toBe('+233200000999');
    expect(classifyQuery('0123').phone).toBeNull();
    expect(classifyQuery('0123').digits).toBe('0123');
    expect(classifyQuery('Ama 1234').digits).toBeNull();
  });
  it('detects receipts and classes', () => {
    expect(classifyQuery('rcp-000412').receiptPrefix).toBe('RCP-000412');
    expect(classifyQuery('jhs 2').classLike).toBe('JHS2');
    expect(classifyQuery('P4 B').classLike).toBe('P4B');
    expect(classifyQuery('Mensah').classLike).toBeNull();
  });
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_a\\')).toBe('50\\%\\_a\\\\');
  });
});
