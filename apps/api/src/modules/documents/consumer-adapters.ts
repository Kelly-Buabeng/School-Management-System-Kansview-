// Owner: Agent F.
/**
 * Adapters from the data shapes the finance (C) and academics/withdrawals (B) modules already pass to
 * PdfService.render into the typed template shapes in ./templates. They were written before the template types
 * existed. render() first tries the typed shape; if that fails and an adapter recognises the input, the adapted data
 * is validated instead. Consumers can move to the typed shapes (import from documents/templates) at any time.
 *
 * Adapters drop any `school` the caller passes (those carry `logoFileId`, not image data): the header always comes
 * from SchoolHeaderSource, which reads school_profile and the logo file.
 */
import { addDays } from './adapter-dates';
import type { Db } from '../../common/db/database.module';
import type { PdfDocType } from '../../common/contracts';

type Obj = Record<string, unknown>;
type Adapter = (d: Obj, db: Db) => Promise<Obj | null>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const date10 = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const todayIso = (): string => new Date().toISOString().slice(0, 10);

const METHOD_LABEL: Record<string, string> = { cash: 'Cash', momo: 'Mobile Money', mobile_money: 'Mobile Money', bank: 'Bank deposit', bank_transfer: 'Bank transfer', cheque: 'Cheque' };

async function studentRef(db: Db, studentId: string): Promise<{ code: string; fullName: string; className: string | null } | null> {
  const s = await db.selectFrom('students as s')
    .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null))
    .leftJoin('classes as c', 'c.id', 'e.class_id')
    .select(['s.student_code', 's.first_name', 's.middle_names', 's.last_name', 'c.display_name'])
    .where('s.id', '=', studentId).executeTakeFirst();
  if (!s) return null;
  return { code: s.student_code, fullName: [s.first_name, s.middle_names, s.last_name].filter(Boolean).join(' '), className: s.display_name };
}

function ledgerLines(entries: unknown[]): Obj[] {
  return entries.filter(isObj).map((e) => {
    const amt = int(e.amountPesewas);
    return {
      date: date10(e.postedAt) ?? todayIso(),
      description: [str(e.description) ?? str(e.entryType) ?? 'Entry', str(e.termName) ? `(${str(e.termName)})` : null].filter(Boolean).join(' '),
      reference: str(e.receiptNo),
      debitPesewas: amt > 0 ? amt : null,
      creditPesewas: amt < 0 ? -amt : null,
      balancePesewas: int(e.runningBalancePesewas),
    };
  });
}

const receipt: Adapter = async (d) => {
  if (!str(d.receiptNo) || !str(d.studentCode)) return null;
  const allocations = Array.isArray(d.allocations) ? d.allocations.filter(isObj).map((a) => ({ description: str(a.feeItemName) ?? 'Fees', amountPesewas: int(a.amountPesewas) })) : [];
  const credit = int(d.creditCreatedPesewas);
  if (credit > 0) allocations.push({ description: 'Credit kept for future fees', amountPesewas: credit });
  const rev = isObj(d.reversal) && str(d.reversal.reversedAt) ? d.reversal : null;
  return {
    receiptNo: d.receiptNo,
    issuedAt: str(d.receivedAt) ?? new Date().toISOString(),
    student: { code: d.studentCode, fullName: str(d.studentName) ?? String(d.studentCode) },
    payer: str(d.payerName) ? { name: d.payerName } : null,
    method: METHOD_LABEL[String(d.method)] ?? str(d.method) ?? 'Cash',
    reference: str(d.referenceNo),
    amountPesewas: int(d.amountPesewas),
    allocations,
    balanceAfterPesewas: num(d.balanceAfterPesewas),
    receivedBy: str(d.recordedByName) ?? 'School office',
    reversal: rev ? { reversedAt: rev.reversedAt, reason: str(rev.reason) ?? '', reversalNo: str(rev.reversalNo) } : null,
    ...(d.format === 'thermal80' ? { format: 'thermal80' } : {}),
  };
};

const feeStatement: Adapter = async (d, db) => {
  if (!str(d.studentId) || !Array.isArray(d.entries)) return null;
  const student = await studentRef(db, d.studentId as string);
  if (!student) return null;
  const lines = ledgerLines(d.entries);
  const first = d.entries.find(isObj);
  const bal = isObj(d.balance) ? int(d.balance.balancePesewas) : 0;
  const opening = first ? int(first.runningBalancePesewas) - int(first.amountPesewas) : bal;
  const closing = lines.length ? (lines[lines.length - 1]!.balancePesewas as number) : opening;
  const from = date10(d.from);
  const to = date10(d.to);
  return {
    student, periodLabel: from || to ? 'Selected period' : 'All terms', fromDate: from, toDate: to,
    openingBalancePesewas: opening, lines, closingBalancePesewas: closing,
  };
};

const arrearsNotice: Adapter = async (d, db) => {
  if (!str(d.studentId) || !isObj(d.balance)) return null;
  const sid = d.studentId as string;
  const student = await studentRef(db, sid);
  if (!student) return null;
  const g = await db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
    .select(['g.title', 'g.first_name', 'g.last_name', 'g.home_address'])
    .where('sg.student_id', '=', sid).orderBy('sg.is_fee_payer', 'desc').orderBy('sg.is_primary', 'desc').executeTakeFirst();
  const b = d.balance;
  const items: Obj[] = [];
  if (int(b.arrearsPesewas) > 0) items.push({ termName: 'Previous terms', description: 'Unpaid fees', amountPesewas: int(b.arrearsPesewas) });
  if (int(b.currentTermOutstandingPesewas) > 0) items.push({ termName: 'Current term', description: 'Unpaid fees', amountPesewas: int(b.currentTermOutstandingPesewas) });
  const total = Math.max(int(b.balancePesewas), 0);
  if (!items.length) items.push({ termName: '-', description: total > 0 ? 'Unpaid fees' : 'No outstanding fees', amountPesewas: total });
  return {
    noticeDate: todayIso(),
    guardian: { fullName: g ? [g.title, g.first_name, g.last_name].filter(Boolean).join(' ') : 'Parent/Guardian', address: g?.home_address ?? null },
    student, items, totalArrearsPesewas: total, dueDate: addDays(todayIso(), 14),
    signatory: { name: 'The Bursar', title: 'Accounts Office' },
  };
};

const guardianStatement: Adapter = async (d) => {
  if (!str(d.guardianName) || !Array.isArray(d.children)) return null;
  const students = d.children.filter(isObj).map((c) => ({
    student: { code: str(c.studentCode) ?? '-', fullName: str(c.studentName) ?? '-' },
    openingBalancePesewas: int(c.balancePesewas), lines: [], closingBalancePesewas: int(c.balancePesewas),
  }));
  if (!students.length) students.push({ student: { code: '-', fullName: 'No children billed to this guardian' }, openingBalancePesewas: 0, lines: [], closingBalancePesewas: 0 });
  return { guardian: { fullName: d.guardianName }, periodLabel: `As at ${todayIso()}`, students, totalBalancePesewas: int(d.totalBalancePesewas) };
};

const invoice: Adapter = async (d) => {
  if (!str(d.invoiceNo) || !Array.isArray(d.lines)) return null;
  const lines = d.lines.filter(isObj).map((l) => ({ description: str(l.description) ?? str(l.feeItemName) ?? 'Fee', amountPesewas: int(l.amountPesewas) }));
  const subtotal = lines.reduce((s, l) => s + l.amountPesewas, 0);
  const adj = Math.abs(int(d.adjustmentsPesewas));
  const opening = int(d.openingBalancePesewas);
  const total = int(d.totalPesewas) || subtotal;
  return {
    invoiceNo: d.invoiceNo, issueDate: date10(d.issueDate) ?? todayIso(), dueDate: date10(d.dueDate), termName: str(d.termName) ?? '-',
    student: { code: str(d.studentCode) ?? '-', fullName: str(d.studentName) ?? '-', className: str(d.className) },
    lines: lines.length ? lines : [{ description: 'No items', amountPesewas: 0 }],
    subtotalPesewas: subtotal, discountPesewas: adj || null, totalPesewas: total,
    previousBalancePesewas: opening || null,
    amountDuePesewas: num(d.outstandingPesewas) !== null && d.status === 'issued' ? int(d.outstandingPesewas) + opening : total + opening,
    notes: d.status === 'void' ? `VOID${str(d.voidReason) ? `: ${d.voidReason}` : ''}` : null,
  };
};

const tableReport: Adapter = async (d) => {
  if (!str(d.title) || !Array.isArray(d.columns) || !Array.isArray(d.rows)) return null;
  const columns = d.columns.filter(isObj).map((c) => ({ key: String(c.key), label: String(c.label ?? c.key), format: ['text', 'money', 'number', 'date'].includes(String(c.type)) ? c.type : 'text' }));
  const cell = (v: unknown): string | number | null => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : JSON.stringify(v));
  const rowOf = (r: Obj) => Object.fromEntries(columns.map((c) => [c.key, cell(r[c.key])]));
  const filters = isObj(d.filters) ? Object.entries(d.filters).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => ({ label: k, value: String(v) })) : [];
  return {
    title: d.title, columns, rows: d.rows.filter(isObj).map(rowOf), filters,
    totals: isObj(d.totals) ? rowOf(d.totals) : null,
    orientation: columns.length > 6 ? 'landscape' : 'portrait',
  };
};

function reportCardFromB(p: Obj): Obj | null {
  const rc = isObj(p.reportCard) ? p.reportCard : null;
  const term = isObj(p.term) ? p.term : null;
  if (!rc || !term || !Array.isArray(p.subjects)) return null;
  const w = isObj(p.weights) ? p.weights : {};
  const position = num(rc.position);
  const size = num(rc.classSize);
  return {
    student: { code: str(rc.studentCode) ?? '-', fullName: str(rc.studentName) ?? '-', className: str(rc.className) ?? '-' },
    academicYear: str(term.academicYear) ?? '-',
    termName: str(term.name) ?? '-',
    classScoreWeight: num(w.classScoreWeight), examScoreWeight: num(w.examScoreWeight),
    subjects: p.subjects.filter(isObj).map((s) => ({
      subject: str(s.name) ?? '-', classScore: num(s.classScore), examScore: num(s.examScore), totalScore: num(s.total), grade: str(s.grade), remark: str(s.remark),
    })),
    totalScore: num(rc.overallTotal), averageScore: num(rc.average),
    position: position && size && position <= size ? { rank: position, of: size } : null,
    attendance: num(rc.attendanceTotal) !== null ? { present: int(rc.attendancePresent), total: int(rc.attendanceTotal) } : null,
    conduct: str(rc.conduct), interest: str(rc.interest),
    classTeacherRemark: str(rc.classTeacherRemark), headteacherRemark: str(rc.headRemark),
    nextTermBegins: date10(rc.nextTermBegins),
  };
}

const reportCard: Adapter = async (d) => reportCardFromB(d);

const classReportCards: Adapter = async (d) => {
  if (!str(d.className) || !Array.isArray(d.pages)) return null;
  const cards = d.pages.filter(isObj).map(reportCardFromB);
  if (!cards.length || cards.some((c) => c === null)) return null;
  const first = d.pages.find(isObj);
  const termName = first && isObj(first.term) ? str(first.term.name) : null;
  return { className: d.className, termName: termName ?? '-', cards };
};

const transferLetter: Adapter = async (d) => {
  if (!str(d.letterNo) || !isObj(d.student)) return null;
  const s = d.student;
  return {
    letterNo: d.letterNo, date: date10(d.issuedOn) ?? todayIso(),
    student: {
      code: str(s.studentCode) ?? str(s.code) ?? '-', fullName: str(s.fullName) ?? '-', dateOfBirth: date10(s.dateOfBirth),
      gender: str(s.gender), admissionDate: date10(s.admissionDate), lastClass: str(s.lastClass),
    },
    destinationSchool: str(d.destinationSchool), reason: str(d.reason), lastAttendanceDate: date10(d.effectiveDate),
    feesCleared: true, // B only issues the letter after clearance (withdrawals:complete)
    signatory: { name: str(d.signedBy) ?? 'The Headteacher', title: 'Headteacher' },
  };
};

export const CONSUMER_ADAPTERS: Partial<Record<PdfDocType, Adapter>> = {
  receipt, fee_statement: feeStatement, arrears_notice: arrearsNotice, guardian_statement: guardianStatement,
  invoice, table_report: tableReport, report_card: reportCard, class_report_cards: classReportCards, transfer_letter: transferLetter,
};
