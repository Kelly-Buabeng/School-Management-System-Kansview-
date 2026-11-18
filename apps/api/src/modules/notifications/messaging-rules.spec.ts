import { describe, expect, it } from 'vitest';
import { earliestSendTime, isQuietHours } from './quiet-hours';
import { detectEncoding, estimateCostPesewas, smsInfo } from './sms-encoding';
import { placeholdersIn, renderTemplate, validateTemplate } from './template-engine';

describe('SMS encoding and segments', () => {
  it('detects GSM-7 vs UCS-2', () => {
    expect(detectEncoding('Dear Kwame, fees GHS 100.00 due 1/12.')).toBe('GSM-7');
    expect(detectEncoding('Fees: GH₵ 100')).toBe('UCS-2'); // cedi sign is not GSM-7
    expect(detectEncoding('Akwaaba 😀')).toBe('UCS-2');
    expect(detectEncoding('Price €5 [x]')).toBe('GSM-7');
  });
  it('counts segments at the 160/153 and 70/67 boundaries', () => {
    expect(smsInfo('').segments).toBe(0);
    expect(smsInfo('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1, remainingInSegment: 0 });
    expect(smsInfo('a'.repeat(161)).segments).toBe(2);
    expect(smsInfo('a'.repeat(306)).segments).toBe(2);
    expect(smsInfo('a'.repeat(307)).segments).toBe(3);
    expect(smsInfo('€'.repeat(80))).toMatchObject({ units: 160, segments: 1 });
    expect(smsInfo('₵'.repeat(70)).segments).toBe(1);
    expect(smsInfo('₵'.repeat(71)).segments).toBe(2);
    expect(smsInfo('₵'.repeat(134)).segments).toBe(2);
    expect(smsInfo('₵'.repeat(135)).segments).toBe(3);
  });
  it('estimates cost per segment', () => {
    expect(estimateCostPesewas(10)).toBe(30);
    expect(estimateCostPesewas(10, 5)).toBe(50);
  });
});

describe('template engine', () => {
  it('accepts allowed placeholders (seeded fee reminder)', () => {
    const body = 'Dear {{guardianName}}, {{studentName}} ({{studentCode}}) has an outstanding balance of {{balance}} for {{termName}}. Kindly pay by {{dueDate}}. Thank you. {{schoolName}}';
    expect(validateTemplate('fee_reminder', body)).toEqual(['guardianName', 'studentName', 'studentCode', 'balance', 'termName', 'dueDate', 'schoolName']);
  });
  it('rejects unknown placeholders with TEMPLATE_PLACEHOLDER_INVALID', () => {
    expect(() => validateTemplate('absence_alert', 'Hi {{guardianName}}, balance {{balance}}')).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_PLACEHOLDER_INVALID', status: 422 }));
  });
  it('rejects HTML and malformed placeholders', () => {
    expect(() => validateTemplate('announcement', '<b>{{message}}</b>')).toThrowError(expect.objectContaining({ code: 'TEMPLATE_PLACEHOLDER_INVALID' }));
    expect(() => validateTemplate('announcement', 'Hello {{message}')).toThrowError(expect.objectContaining({ code: 'TEMPLATE_PLACEHOLDER_INVALID' }));
    expect(() => validateTemplate('announcement', '{{ 1abc }}')).toThrowError(expect.objectContaining({ code: 'TEMPLATE_PLACEHOLDER_INVALID' }));
  });
  it('renders values without letting them inject placeholders', () => {
    const r = renderTemplate('Dear {{guardianName}}, {{message}}', { guardianName: 'Kwame {{balance}}', message: 'Line1\nLine2 <script>' });
    expect(r.text).toBe('Dear Kwame balance, Line1 Line2 script');
    expect(r.missing).toEqual([]);
    expect(renderTemplate('Hi {{studentName}}!', {}).missing).toEqual(['studentName']);
    expect(placeholdersIn('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('quiet hours (Africa/Accra, 20:00 to 07:00)', () => {
  it('detects quiet hours', () => {
    expect(isQuietHours(new Date('2026-11-17T19:59:00Z'))).toBe(false);
    expect(isQuietHours(new Date('2026-11-17T20:00:00Z'))).toBe(true);
    expect(isQuietHours(new Date('2026-11-18T06:59:00Z'))).toBe(true);
    expect(isQuietHours(new Date('2026-11-18T07:00:00Z'))).toBe(false);
  });
  it('delays non-emergency messages to 07:00', () => {
    expect(earliestSendTime(new Date('2026-11-17T21:30:00Z'), false).toISOString()).toBe('2026-11-18T07:00:00.000Z');
    expect(earliestSendTime(new Date('2026-11-18T03:00:00Z'), false).toISOString()).toBe('2026-11-18T07:00:00.000Z');
    expect(earliestSendTime(new Date('2026-12-31T23:00:00Z'), false).toISOString()).toBe('2027-01-01T07:00:00.000Z');
    const noon = new Date('2026-11-18T12:00:00Z');
    expect(earliestSendTime(noon, false)).toBe(noon);
  });
  it('never delays emergencies', () => {
    const night = new Date('2026-11-17T23:00:00Z');
    expect(earliestSendTime(night, true)).toBe(night);
  });
});
