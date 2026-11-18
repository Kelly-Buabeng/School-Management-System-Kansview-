import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import ExcelJS from 'exceljs';
import { addPesewas, todayInAccra } from '@sms/shared';
import { KYSELY, type Db } from '../../common/db/database.module';
import { PDF_SERVICE, type PdfService } from '../../common/contracts';
import { checkSequence, emptyByMethod, expectedByMethod, methodLabel, netAllocations, PAYMENT_METHODS, type PaymentMethod } from './domain';
import { LedgerServiceImpl } from './ledger.service';
import { CashUpsService } from './cash-ups.service';
import { toIso } from './finance-store';
import { fullName } from './support';

export interface Column { key: string; label: string; type: 'text' | 'money' | 'number' | 'date' }
export interface Report {
  title: string;
  generatedAt: string;
  filters: Record<string, unknown>;
  columns: Column[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
  sections?: Record<string, unknown>;
}

const Q_DATE = sql<string>`(p.received_at at time zone 'Africa/Accra')::date`;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly ledger: LedgerServiceImpl,
    private readonly cashUps: CashUpsService,
    @Inject(PDF_SERVICE) private readonly pdf: PdfService,
  ) {}

  private paymentsIn(from?: string, to?: string) {
    let q = this.db.selectFrom('payments as p').where('p.status', '=', 'confirmed');
    if (from) q = q.where(Q_DATE, '>=', from);
    if (to) q = q.where(Q_DATE, '<=', to);
    return q;
  }

  async collections(groupBy: 'day' | 'term' | 'method' | 'class' | 'fee_item', from?: string, to?: string): Promise<Report> {
    const groups = new Map<string, { label: string; amount: number; count: number }>();
    const add = (key: string, label: string, amount: number, count = 1) => {
      const g = groups.get(key) ?? { label, amount: 0, count: 0 };
      g.amount = addPesewas(g.amount, amount);
      g.count += count;
      groups.set(key, g);
    };
    if (groupBy === 'day' || groupBy === 'method') {
      const rows = await this.paymentsIn(from, to).select([Q_DATE.as('d'), 'p.method', 'p.amount_pesewas']).execute();
      for (const r of rows) {
        if (groupBy === 'day') add(String(r.d), String(r.d), Number(r.amount_pesewas));
        else add(r.method, methodLabel(r.method as PaymentMethod), Number(r.amount_pesewas));
      }
    } else {
      // by where the money went: net allocations of the payments taken in the period
      const rows = await this.paymentsIn(from, to)
        .innerJoin('payment_allocations as pa', 'pa.payment_id', 'p.id')
        .leftJoin('invoice_lines as il', 'il.id', 'pa.invoice_line_id')
        .leftJoin('invoices as i', 'i.id', 'il.invoice_id')
        .leftJoin('terms as t', 't.id', 'i.term_id')
        .leftJoin('classes as c', 'c.id', 'i.class_id')
        .leftJoin('fee_items as fi', 'fi.id', 'il.fee_item_id')
        .select(['p.id as payment_id', 'pa.invoice_line_id', 'pa.amount_pesewas', 't.id as term_id', 't.name as term_name', 'c.id as class_id', 'c.display_name', 'fi.id as fee_item_id', 'fi.name as fee_item_name', 'il.description'])
        .execute();
      const byLine = new Map<string | null, (typeof rows)[number]>();
      for (const r of rows) byLine.set(r.invoice_line_id, r);
      const nets = new Map<string, Array<{ invoiceLineId: string | null; amountPesewas: number }>>();
      for (const r of rows) {
        const arr = nets.get(r.payment_id) ?? [];
        arr.push({ invoiceLineId: r.invoice_line_id, amountPesewas: Number(r.amount_pesewas) });
        nets.set(r.payment_id, arr);
      }
      for (const arr of nets.values()) {
        for (const n of netAllocations(arr)) {
          const m = byLine.get(n.invoiceLineId);
          if (n.invoiceLineId === null || !m) { add('credit', 'Credit (not yet applied)', n.amountPesewas, 0); continue; }
          if (groupBy === 'term') add(m.term_id ?? '-', m.term_name ?? '-', n.amountPesewas, 0);
          else if (groupBy === 'class') add(m.class_id ?? '-', m.display_name ?? 'No class', n.amountPesewas, 0);
          else add(m.fee_item_id ?? m.description ?? '-', m.fee_item_name ?? m.description ?? '-', n.amountPesewas, 0);
        }
      }
    }
    const rows = [...groups.entries()].map(([key, g]) => ({ key, group: g.label, amountPesewas: g.amount, payments: g.count })).sort((a, b) => (a.group < b.group ? -1 : 1));
    return {
      title: 'Collections', generatedAt: new Date().toISOString(), filters: { groupBy, from: from ?? null, to: to ?? null },
      columns: [{ key: 'group', label: groupLabel(groupBy), type: 'text' }, { key: 'amountPesewas', label: 'Amount', type: 'money' }, ...(groupBy === 'day' || groupBy === 'method' ? [{ key: 'payments', label: 'Payments', type: 'number' as const }] : [])],
      rows,
      totals: { amountPesewas: addPesewas(0, ...rows.map((r) => r.amountPesewas)) },
    };
  }

  private async studentInfo(ids: string[]) {
    if (ids.length === 0) return new Map<string, { code: string; name: string; className: string | null; classId: string | null }>();
    const rows = await this.db.selectFrom('students as s')
      .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null))
      .leftJoin('classes as c', 'c.id', 'e.class_id')
      .select(['s.id', 's.student_code', 's.first_name', 's.middle_names', 's.last_name', 'c.id as class_id', 'c.display_name'])
      .where('s.id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, { code: r.student_code, name: fullName(r.first_name, r.middle_names, r.last_name), className: r.display_name, classId: r.class_id }]));
  }

  async aging(): Promise<Report> {
    const all = await this.ledger.aging(null);
    const owing = [...all.entries()].filter(([, a]) => a.balance > 0);
    const info = await this.studentInfo(owing.map(([id]) => id));
    const rows = owing.map(([id, a]) => ({
      studentId: id, studentCode: info.get(id)?.code, studentName: info.get(id)?.name, className: info.get(id)?.className ?? null,
      currentPesewas: a.buckets.currentPesewas, oneTermPesewas: a.buckets.oneTermPesewas, twoTermsPesewas: a.buckets.twoTermsPesewas,
      threePlusTermsPesewas: a.buckets.threePlusTermsPesewas, totalPesewas: a.buckets.totalPesewas,
    })).sort((x, y) => y.totalPesewas - x.totalPesewas);
    const sum = (k: keyof (typeof rows)[number]) => addPesewas(0, ...rows.map((r) => Number(r[k])));
    return {
      title: 'Fees aging', generatedAt: new Date().toISOString(), filters: {},
      columns: [
        { key: 'studentCode', label: 'Student ID', type: 'text' }, { key: 'studentName', label: 'Name', type: 'text' }, { key: 'className', label: 'Class', type: 'text' },
        { key: 'currentPesewas', label: 'This term', type: 'money' }, { key: 'oneTermPesewas', label: '1 term', type: 'money' },
        { key: 'twoTermsPesewas', label: '2 terms', type: 'money' }, { key: 'threePlusTermsPesewas', label: '3+ terms', type: 'money' }, { key: 'totalPesewas', label: 'Total', type: 'money' },
      ],
      rows,
      totals: { currentPesewas: sum('currentPesewas'), oneTermPesewas: sum('oneTermPesewas'), twoTermsPesewas: sum('twoTermsPesewas'), threePlusTermsPesewas: sum('threePlusTermsPesewas'), totalPesewas: sum('totalPesewas'), students: rows.length },
    };
  }

  async defaulters(minOutstanding = 1, classId?: string): Promise<Report> {
    const bal = await this.db.selectFrom('ledger_entries').select(['student_id', sql<string>`sum(amount_pesewas)`.as('b')]).groupBy('student_id')
      .having(sql`sum(amount_pesewas)`, '>=', Math.max(1, minOutstanding)).execute();
    const info = await this.studentInfo(bal.map((b) => b.student_id));
    const payers = bal.length === 0 ? [] : await this.db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .select(['sg.student_id', 'g.first_name', 'g.last_name', 'g.phone_primary', 'sg.is_primary'])
      .where('sg.student_id', 'in', bal.map((b) => b.student_id)).where('sg.is_fee_payer', '=', true).orderBy('sg.is_primary', 'desc').execute();
    const lastPay = bal.length === 0 ? [] : await this.db.selectFrom('payments').select(['student_id', (eb) => eb.fn.max('received_at').as('m')])
      .where('student_id', 'in', bal.map((b) => b.student_id)).where('status', '=', 'confirmed').groupBy('student_id').execute();
    const rows = bal
      .filter((b) => !classId || info.get(b.student_id)?.classId === classId)
      .map((b) => {
        const p = payers.find((x) => x.student_id === b.student_id);
        const lp = lastPay.find((x) => x.student_id === b.student_id);
        return {
          studentId: b.student_id, studentCode: info.get(b.student_id)?.code, studentName: info.get(b.student_id)?.name, className: info.get(b.student_id)?.className ?? null,
          outstandingPesewas: Number(b.b), feePayer: p ? `${p.first_name} ${p.last_name}` : null, feePayerPhone: p?.phone_primary ?? null,
          lastPaymentAt: lp?.m ? toIso(lp.m) : null,
        };
      }).sort((x, y) => y.outstandingPesewas - x.outstandingPesewas);
    return {
      title: 'Defaulters', generatedAt: new Date().toISOString(), filters: { minOutstandingPesewas: minOutstanding, classId: classId ?? null },
      columns: [
        { key: 'studentCode', label: 'Student ID', type: 'text' }, { key: 'studentName', label: 'Name', type: 'text' }, { key: 'className', label: 'Class', type: 'text' },
        { key: 'outstandingPesewas', label: 'Owed', type: 'money' }, { key: 'feePayer', label: 'Fee payer', type: 'text' }, { key: 'feePayerPhone', label: 'Phone', type: 'text' },
        { key: 'lastPaymentAt', label: 'Last payment', type: 'date' },
      ],
      rows,
      totals: { outstandingPesewas: addPesewas(0, ...rows.map((r) => r.outstandingPesewas)), students: rows.length },
    };
  }

  async dailyCashUp(date: string): Promise<Report> {
    const cu = await this.db.selectFrom('cash_ups').select('id').where('business_date', '=', date).executeTakeFirst();
    const ps = await this.cashUps.paymentsFor(this.db, date, cu?.id);
    const info = await this.studentInfo([...new Set(ps.map((p) => p.student_id))]);
    const rows = ps.map((p) => ({
      receiptNo: p.receipt_no, receivedAt: toIso(p.received_at), studentCode: info.get(p.student_id)?.code, studentName: info.get(p.student_id)?.name,
      method: methodLabel(p.method as PaymentMethod), referenceNo: p.reference_no, amountPesewas: Number(p.amount_pesewas), status: p.status,
    }));
    const exp = expectedByMethod(ps.map((p) => ({ method: p.method as PaymentMethod, amountPesewas: Number(p.amount_pesewas), status: p.status })));
    return {
      title: `Daily cash-up ${date}`, generatedAt: new Date().toISOString(), filters: { date },
      columns: [
        { key: 'receiptNo', label: 'Receipt', type: 'text' }, { key: 'receivedAt', label: 'Time', type: 'date' }, { key: 'studentCode', label: 'Student ID', type: 'text' },
        { key: 'studentName', label: 'Name', type: 'text' }, { key: 'method', label: 'Method', type: 'text' }, { key: 'referenceNo', label: 'Reference', type: 'text' },
        { key: 'amountPesewas', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status', type: 'text' },
      ],
      rows,
      totals: { expectedByMethod: exp, expectedTotalPesewas: addPesewas(0, ...Object.values(exp)), reversed: rows.filter((r) => r.status === 'reversed').length },
      sections: { cashUp: cu ? await this.cashUps.get(cu.id) : null },
    };
  }

  async reconciliation(from?: string, to?: string): Promise<Report> {
    const receipts = await this.db.selectFrom('payments').select('receipt_no').execute();
    const counter = await this.db.selectFrom('doc_counters').select(['last_value', 'prefix']).where('doc_type', '=', 'receipt').executeTakeFirst();
    const seq = checkSequence(receipts.map((r) => r.receipt_no), 1);
    const last = Number(counter?.last_value ?? 0);
    if (seq.last !== null && last > seq.last) seq.gaps.push({ from: seq.last + 1, to: last });
    if (seq.last === null && last > 0) seq.gaps.push({ from: 1, to: last });

    const byMethod = emptyByMethod();
    const ps = await this.paymentsIn(from, to).select(['p.method', 'p.amount_pesewas']).execute();
    for (const p of ps) byMethod[p.method as PaymentMethod] = addPesewas(byMethod[p.method as PaymentMethod], Number(p.amount_pesewas));
    let cq = this.db.selectFrom('cash_ups').selectAll().where('status', '=', 'closed');
    if (from) cq = cq.where('business_date', '>=', from);
    if (to) cq = cq.where('business_date', '<=', to);
    const cus = await cq.orderBy('business_date').execute();
    const cashUpExpected = emptyByMethod();
    const cashUpCounted = emptyByMethod();
    for (const c of cus) for (const m of PAYMENT_METHODS) {
      cashUpExpected[m] += Number((c.expected_by_method as Record<string, number> | null)?.[m] ?? 0);
      cashUpCounted[m] += Number((c.counted_by_method as Record<string, number> | null)?.[m] ?? 0);
    }
    let rq = this.db.selectFrom('payment_reversals as r').innerJoin('payments as p', 'p.id', 'r.payment_id')
      .select(['r.reversal_no', 'r.status', 'r.reason', 'r.requested_by', 'r.approved_by', 'r.requested_at', 'r.approved_at', 'p.receipt_no', 'p.amount_pesewas', 'p.method']);
    if (from) rq = rq.where(sql<string>`(r.requested_at at time zone 'Africa/Accra')::date`, '>=', from);
    if (to) rq = rq.where(sql<string>`(r.requested_at at time zone 'Africa/Accra')::date`, '<=', to);
    const reversals = (await rq.orderBy('r.requested_at').execute()).map((r) => ({
      reversalNo: r.reversal_no, status: r.status, receiptNo: r.receipt_no, amountPesewas: Number(r.amount_pesewas), method: r.method, reason: r.reason,
      requestedBy: r.requested_by, approvedBy: r.approved_by, requestedAt: toIso(r.requested_at), approvedAt: r.approved_at ? toIso(r.approved_at) : null,
    }));
    const rows = PAYMENT_METHODS.map((m) => ({
      method: methodLabel(m), recordedPesewas: byMethod[m], cashUpExpectedPesewas: cashUpExpected[m], cashUpCountedPesewas: cashUpCounted[m],
      differencePesewas: cashUpCounted[m] - cashUpExpected[m],
    }));
    return {
      title: 'Reconciliation', generatedAt: new Date().toISOString(), filters: { from: from ?? null, to: to ?? null },
      columns: [
        { key: 'method', label: 'Method', type: 'text' }, { key: 'recordedPesewas', label: 'Recorded', type: 'money' },
        { key: 'cashUpExpectedPesewas', label: 'Cash-up expected', type: 'money' }, { key: 'cashUpCountedPesewas', label: 'Counted', type: 'money' },
        { key: 'differencePesewas', label: 'Difference', type: 'money' },
      ],
      rows,
      totals: { recordedPesewas: addPesewas(0, ...Object.values(byMethod)) },
      sections: {
        receiptSequence: { ok: seq.gaps.length === 0 && seq.duplicates.length === 0, count: seq.count, first: seq.first, last: seq.last, counterLastValue: last, gaps: seq.gaps, duplicates: seq.duplicates },
        reversals,
        cashUpsClosed: cus.length,
      },
    };
  }

  async toXlsx(r: Report): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();
    const ws = wb.addWorksheet(r.title.slice(0, 31));
    ws.addRow([r.title]).font = { bold: true, size: 14 };
    ws.addRow([`Generated ${todayInAccra()}`]);
    ws.addRow([]);
    ws.addRow(r.columns.map((c) => c.label)).font = { bold: true };
    for (const row of r.rows) {
      ws.addRow(r.columns.map((c) => {
        const v = row[c.key];
        if (c.type === 'money' && typeof v === 'number') return v / 100; // display only: cedis in the spreadsheet cell
        return v ?? '';
      }));
    }
    r.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.type === 'text' ? 28 : 16;
      if (c.type === 'money') col.numFmt = '#,##0.00';
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async toPdf(r: Report): Promise<Buffer> {
    return this.pdf.render('table_report', r as unknown as Record<string, unknown>);
  }
}

function groupLabel(g: string): string {
  return { day: 'Day', term: 'Term', method: 'Method', class: 'Class', fee_item: 'Fee item' }[g] ?? g;
}
