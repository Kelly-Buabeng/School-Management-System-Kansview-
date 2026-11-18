// Owner: Agent F. Fake Ghanaian data for PDF tests. Not real people.
import type { PdfDataByType, ReportCard, SchoolHeader } from '../../src/modules/documents/templates';

// 1x1 transparent PNG
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const school: SchoolHeader = {
  name: 'Kansview Preparatory School',
  motto: 'Knowledge and Character',
  address: 'P.O. Box 123, Kasoa',
  phone: '+233200000001',
  email: 'office@example.edu.gh',
  logoDataUrl: `data:image/png;base64,${TINY_PNG}`,
};

const student = { code: 'KSV-26-00417-7', fullName: 'Ama Serwaa Mensah', className: 'Basic 4A' };

const card = (name: string, code: string, rank: number): ReportCard => ({
  student: { code, fullName: name, className: 'Basic 4A', gender: 'Female' },
  academicYear: '2026/2027',
  termName: 'Term 1',
  classScoreWeight: 30,
  examScoreWeight: 70,
  subjects: [
    { subject: 'English Language', classScore: 26, examScore: 60, totalScore: 86, grade: 'A', remark: 'Excellent', position: 2 },
    { subject: 'Mathematics', classScore: 24, examScore: 55, totalScore: 79, grade: 'B', remark: 'Very good', position: 5 },
    { subject: 'Integrated Science', classScore: 22, examScore: 50, totalScore: 72, grade: 'B', remark: 'Good', position: 7 },
  ],
  totalScore: 237,
  averageScore: 79,
  overallGrade: 'B',
  position: { rank, of: 34 },
  attendance: { present: 58, total: 62 },
  conduct: 'Respectful',
  interest: 'Reading',
  classTeacherRemark: 'Hardworking and attentive.',
  headteacherRemark: 'Keep it up.',
  classTeacherName: 'Mr Kofi Asante',
  headteacherName: 'Mrs Efua Owusu',
  nextTermBegins: '2027-01-12',
});

export const fixtures: PdfDataByType = {
  receipt: {
    receiptNo: 'RCP-000412',
    issuedAt: '2026-11-17T10:15:00Z',
    student,
    payer: { name: 'Kwame Mensah', phone: '+233240000123' },
    method: 'Mobile Money',
    reference: 'MM-77881',
    amountPesewas: 125050,
    allocations: [{ description: 'Tuition', termName: 'Term 1', amountPesewas: 100000 }, { description: 'Feeding', amountPesewas: 25050 }],
    balanceAfterPesewas: 30000,
    receivedBy: 'Abena Bursar',
  },
  fee_statement: {
    student,
    periodLabel: '2026/2027 Term 1',
    fromDate: '2026-09-01',
    toDate: '2026-11-17',
    openingBalancePesewas: 20000,
    lines: [
      { date: '2026-09-02', description: 'Term 1 bill', reference: 'INV-000101', debitPesewas: 150000, balancePesewas: 170000 },
      { date: '2026-10-05', description: 'Payment', reference: 'RCP-000412', creditPesewas: 125050, balancePesewas: 44950 },
    ],
    closingBalancePesewas: 44950,
  },
  guardian_statement: {
    guardian: { fullName: 'Kwame Mensah', phone: '+233240000123' },
    periodLabel: '2026/2027 Term 1',
    students: [
      { student, openingBalancePesewas: 0, lines: [{ date: '2026-09-02', description: 'Term 1 bill', debitPesewas: 150000, balancePesewas: 150000 }], closingBalancePesewas: 150000 },
      { student: { code: 'KSV-26-00418-2', fullName: 'Kojo Mensah', className: 'Basic 2B' }, openingBalancePesewas: 0, lines: [], closingBalancePesewas: 50000 },
    ],
    totalBalancePesewas: 200000,
  },
  arrears_notice: {
    noticeDate: '2026-11-17',
    guardian: { fullName: 'Kwame Mensah', address: 'Kasoa New Market' },
    student,
    items: [{ termName: '2025/2026 Term 3', description: 'Tuition', amountPesewas: 80000 }],
    totalArrearsPesewas: 80000,
    dueDate: '2026-12-01',
    signatory: { name: 'Mrs Efua Owusu', title: 'Headteacher' },
  },
  invoice: {
    invoiceNo: 'INV-000101',
    issueDate: '2026-09-02',
    dueDate: '2026-09-30',
    termName: '2026/2027 Term 1',
    student,
    lines: [{ description: 'Tuition', amountPesewas: 120000 }, { description: 'PTA levy', amountPesewas: 5000 }],
    subtotalPesewas: 125000,
    discountPesewas: 5000,
    totalPesewas: 120000,
    previousBalancePesewas: 20000,
    amountDuePesewas: 140000,
    paymentInstructions: 'Pay at the school office or by Mobile Money.',
  },
  report_card: card('Ama Serwaa Mensah', 'KSV-26-00417-7', 3),
  class_report_cards: {
    className: 'Basic 4A',
    termName: 'Term 1',
    cards: [card('Ama Serwaa Mensah', 'KSV-26-00417-7', 3), card('Yaw Boateng', 'KSV-26-00420-1', 1), card('Akosua Darko', 'KSV-26-00421-9', 12)],
  },
  transfer_letter: {
    letterNo: 'TRL-000007',
    date: '2026-11-17',
    student: { code: 'KSV-26-00417-7', fullName: 'Ama Serwaa Mensah', dateOfBirth: '2017-03-04', gender: 'Female', admissionDate: '2022-09-05', lastClass: 'Basic 4A' },
    destinationSchool: 'Sunrise Academy, Tema',
    reason: 'Family relocation',
    lastAttendanceDate: '2026-11-14',
    conduct: 'Very good',
    feesCleared: true,
    signatory: { name: 'Mrs Efua Owusu', title: 'Headteacher' },
  },
  subject_access_pack: {
    requestRef: 'DSR-2026-003',
    requestDate: '2026-11-01',
    subject: { name: 'Kwame Mensah', relationship: 'Guardian' },
    sections: [
      { title: 'Contact details', fields: [{ label: 'Phone', value: '+233240000123' }, { label: 'Receives SMS', value: true }] },
      { title: 'Messages sent', table: { columns: ['Date', 'Message'], rows: [['2026-10-01', 'Fee reminder']] } },
      { title: 'Incidents', fields: [] },
    ],
  },
  table_report: {
    title: 'Fee Defaulters',
    subtitle: 'Basic 4A',
    filters: [{ label: 'Term', value: '2026/2027 Term 1' }],
    columns: [
      { key: 'code', label: 'Student ID' },
      { key: 'name', label: 'Name' },
      { key: 'balance', label: 'Balance', format: 'money' },
      { key: 'lastPaid', label: 'Last paid', format: 'date' },
    ],
    rows: [
      { code: 'KSV-26-00417-7', name: 'Ama Serwaa Mensah', balance: 44950, lastPaid: '2026-10-05' },
      { code: 'KSV-26-00420-1', name: 'Yaw Boateng', balance: 100000, lastPaid: null },
    ],
    totals: { balance: 144950 },
  },
};
