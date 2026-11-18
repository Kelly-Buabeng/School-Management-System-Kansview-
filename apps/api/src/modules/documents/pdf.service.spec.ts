import { describe, expect, it } from 'vitest';
import { PDF_SERVICE } from '../../common/contracts';
import type { PdfDocType } from '../../common/contracts';
import { fixtures, school } from '../../../test/f/pdf-fixtures';
import { pdfPages, pdfText } from '../../../test/f/pdf-text';
import { PdfmakePdfService } from './pdf.service';
import { amountInWords, formatPosition, money, ordinal } from './templates';

const svc = new PdfmakePdfService({ get: async () => school });
const noSchool = new PdfmakePdfService({ get: async () => null });

describe('template helpers', () => {
  it('formats ordinals and positions', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
    expect(formatPosition(3, 34)).toBe('3rd of 34');
  });
  it('formats money through formatCedis', () => {
    expect(money(125050)).toBe('GHS 1,250.50');
    expect(money(-500)).toBe('GHS -5.00');
  });
  it('writes amounts in words', () => {
    expect(amountInWords(125050)).toBe('One thousand two hundred and fifty Ghana cedis and fifty pesewas');
    expect(amountInWords(100)).toBe('One Ghana cedi');
    expect(amountInWords(100_000_000)).toBe('One million Ghana cedis');
  });
});

describe('PdfService', () => {
  it('is bound under the contract token name', () => {
    expect(typeof PDF_SERVICE).toBe('symbol');
  });

  const expectations: Record<PdfDocType, string[]> = {
    receipt: ['OFFICIAL RECEIPT', 'RCP-000412', 'Ama Serwaa Mensah', 'KSV-26-00417-7', 'GHS 1,250.50', 'Mobile Money', 'GHS 300.00', 'Abena Bursar'],
    fee_statement: ['FEE STATEMENT', 'INV-000101', 'Opening balance', 'GHS 449.50', 'Amount owed to the school'],
    guardian_statement: ['FAMILY FEE STATEMENT', 'Kwame Mensah', 'Kojo Mensah', 'GHS 2,000.00'],
    arrears_notice: ['NOTICE OF OUTSTANDING FEES', 'GHS 800.00', '1 Dec 2026', 'Mrs Efua Owusu'],
    invoice: ['INVOICE', 'INV-000101', 'PTA levy', 'GHS 1,400.00', 'Mobile Money'],
    report_card: ['TERMINAL REPORT', 'Mathematics', '3rd of 34', '58 out of 62 days', 'Hardworking and attentive.', '12 Jan 2027', 'Class score (30%)'],
    class_report_cards: ['Yaw Boateng', 'Akosua Darko', '12th of 34'],
    transfer_letter: ['TRANSFER LETTER', 'TRL-000007', 'Sunrise Academy, Tema', 'All fees cleared'],
    subject_access_pack: ['PERSONAL DATA HELD BY THE SCHOOL', 'DSR-2026-003', 'Fee reminder', 'No records.'],
    table_report: ['Fee Defaulters', 'Yaw Boateng', 'GHS 1,449.50', 'TOTAL', '2 rows'],
  };

  it.each(Object.keys(expectations) as PdfDocType[])('renders %s with the key fields and school header', async (docType) => {
    const buf = await svc.render(docType, fixtures[docType] as Record<string, unknown>);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await pdfText(buf);
    expect(text).toContain('KANSVIEW PREPARATORY SCHOOL');
    for (const s of expectations[docType]) expect(text).toContain(s);
  });

  it('renders class report cards one student per page', async () => {
    const pages = await pdfPages(await svc.render('class_report_cards', fixtures.class_report_cards as Record<string, unknown>));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain('Ama Serwaa Mensah');
    expect(pages[1]).toContain('Yaw Boateng');
    expect(pages[1]).toContain('1st of 34');
    expect(pages[2]).toContain('Akosua Darko');
  });

  it('renders the 80 mm thermal receipt variant', async () => {
    const buf = await svc.render('receipt', { ...fixtures.receipt, format: 'thermal80' });
    const text = await pdfText(buf);
    expect(text).toContain('RCP-000412');
    expect(text).toContain('GHS 1,250.50');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const [, , w] = page.view;
    expect(Math.round(w!)).toBe(227); // 80 mm
    await doc.destroy();
  });

  it.each(['COPY', 'REVERSED', 'DRAFT'] as const)('adds the %s watermark', async (watermark) => {
    const text = await pdfText(await svc.render('receipt', fixtures.receipt as Record<string, unknown>, { watermark }));
    expect(text).toContain(watermark);
  });

  it('watermarks reversed receipts automatically', async () => {
    const text = await pdfText(await svc.render('receipt', {
      ...fixtures.receipt, reversal: { reversedAt: '2026-11-18T09:00:00Z', reason: 'Wrong student', reversalNo: 'REV-000003' },
    }));
    expect(text).toContain('REVERSED');
    expect(text).toContain('REV-000003');
    expect(text).toContain('Wrong student');
  });

  it('prints without a school profile when none is configured', async () => {
    const text = await pdfText(await noSchool.render('invoice', fixtures.invoice as Record<string, unknown>));
    expect(text).toContain('INV-000101');
    expect(text).not.toContain('KANSVIEW');
  });

  it('rejects data of the wrong shape with a plain message', async () => {
    await expect(svc.render('receipt', { receiptNo: 'X' })).rejects.toMatchObject({ status: 500, title: 'The document could not be created' });
    await expect(svc.render('receipt', { ...fixtures.receipt, amountPesewas: 12.5 })).rejects.toMatchObject({ status: 500 });
    await expect(svc.render('receipt', { ...fixtures.receipt, unexpected: 1 })).rejects.toMatchObject({ status: 500 });
  });
});
