import { describe, expect, it } from 'vitest';
import { pdfText } from '../../../test/f/pdf-text';
import { school } from '../../../test/f/pdf-fixtures';
import type { Db } from '../../common/db/database.module';
import { PdfmakePdfService } from './pdf.service';

// The adapters below need no database; a dummy Db just enables the adapter path.
const svc = new PdfmakePdfService({ get: async () => school }, {} as Db);

const bCard = (name: string, position: number) => ({
  school: { name: 'X', motto: null, address: null, phone: null, logoFileId: null },
  term: { name: 'Term 1', number: 1, academicYear: '2026/2027', startDate: '2026-09-08', endDate: '2026-12-18' },
  reportCard: {
    studentCode: 'KSV-26-00417-7', studentName: name, className: 'Basic 4A', overallTotal: 237, average: 79, position, positionTied: false,
    positionLabel: '3rd', classSize: 34, attendancePresent: 58, attendanceTotal: 62, conduct: 'Good', interest: 'Reading',
    classTeacherRemark: 'Hardworking.', headRemark: 'Keep it up.', nextTermBegins: '2027-01-12', status: 'draft',
  },
  weights: { classScoreWeight: 30, examScoreWeight: 70 },
  subjects: [{ name: 'Mathematics', code: 'MATH', classScore: 24, examScore: 55, total: 79, grade: 'B2', remark: 'Very good' }],
  gradingKey: [],
});

describe('PdfService accepts the shapes B and C already pass', () => {
  it('receipt from the finance payment view', async () => {
    const text = await pdfText(await svc.render('receipt', {
      school: { name: 'X', address: null, phone: null, email: null, motto: null },
      receiptNo: 'RCP-000001', receivedAt: '2026-11-18T09:00:00.000Z', studentCode: 'KSV-26-00417-7', studentName: 'Ama Mensah', payerName: 'Kwame Mensah',
      amountPesewas: 50000, amountText: 'GH₵ 500.00', method: 'momo', referenceNo: 'MM-1', allocations: [{ invoiceLineId: 'x', feeItemName: 'Tuition', termId: null, amountPesewas: 50000 }],
      creditCreatedPesewas: 0, balanceAfterPesewas: 10000, recordedByName: 'Abena Bursar', reversal: null,
    }, { watermark: 'COPY' }));
    expect(text).toContain('RCP-000001');
    expect(text).toContain('Mobile Money');
    expect(text).toContain('GHS 500.00');
    expect(text).toContain('COPY');
  });

  it('invoice from the finance invoice view', async () => {
    const text = await pdfText(await svc.render('invoice', {
      id: 'i', invoiceNo: 'INV-000009', studentId: 's', studentCode: 'KSV-26-00417-7', studentName: 'Ama Mensah', termId: 't', termName: 'Term 1', classId: 'c', className: 'Basic 4A',
      issueDate: '2026-09-02', dueDate: '2026-09-30', status: 'issued', voidReason: null, voidedAt: null, openingBalancePesewas: 2000, totalPesewas: 100000,
      paidPesewas: 0, adjustmentsPesewas: 0, outstandingPesewas: 100000, lines: [{ id: 'l', feeItemId: 'f', feeItemName: 'Tuition', description: 'Tuition', amountPesewas: 100000, paidPesewas: 0, adjustmentsPesewas: 0, outstandingPesewas: 100000 }],
    }));
    expect(text).toContain('INV-000009');
    expect(text).toContain('GHS 1,020.00');
  });

  it('table_report from a finance report', async () => {
    const text = await pdfText(await svc.render('table_report', {
      title: 'Defaulters', generatedAt: '2026-11-18T09:00:00Z', filters: { minOutstandingPesewas: 1, classId: null },
      columns: [{ key: 'studentName', label: 'Student', type: 'text' }, { key: 'outstandingPesewas', label: 'Owed', type: 'money' }],
      rows: [{ studentName: 'Yaw Boateng', outstandingPesewas: 12345 }], totals: { outstandingPesewas: 12345 },
    }));
    expect(text).toContain('Defaulters');
    expect(text).toContain('GHS 123.45');
  });

  it('guardian_statement from the guardian balance', async () => {
    const text = await pdfText(await svc.render('guardian_statement', {
      guardianId: 'g', guardianName: 'Kwame Mensah', totalBalancePesewas: 30000, totalOwedPesewas: 30000, totalCreditPesewas: 0,
      children: [{ studentCode: 'KSV-26-00417-7', studentName: 'Ama Mensah', status: 'active', balancePesewas: 30000, creditPesewas: 0 }],
    }));
    expect(text).toContain('Kwame Mensah');
    expect(text).toContain('GHS 300.00');
  });

  it('report_card and class_report_cards from academics', async () => {
    const one = await pdfText(await svc.render('report_card', bCard('Ama Mensah', 3), { watermark: 'DRAFT' }));
    expect(one).toContain('3rd of 34');
    expect(one).toContain('Mathematics');
    expect(one).toContain('DRAFT');
    const many = await pdfText(await svc.render('class_report_cards', { className: 'Basic 4A', pages: [bCard('Ama Mensah', 3), bCard('Yaw Boateng', 1)] }));
    expect(many).toContain('Yaw Boateng');
    expect(many).toContain('1st of 34');
  });

  it('transfer_letter from withdrawals', async () => {
    const text = await pdfText(await svc.render('transfer_letter', {
      letterNo: 'TL-000001', issuedOn: '2026-11-18', school: { name: 'X', address: null, phone: null, email: null, motto: null, logoFileId: null },
      student: { studentCode: 'KSV-26-00417-7', fullName: 'Ama Mensah', dateOfBirth: '2017-03-04', gender: 'female', admissionDate: '2022-09-05', lastClass: 'Basic 4A' },
      effectiveDate: '2026-11-14', destinationSchool: 'Sunrise Academy', reason: 'Relocation', signedBy: 'Efua Owusu',
    }));
    expect(text).toContain('TL-000001');
    expect(text).toContain('Sunrise Academy');
  });
});
