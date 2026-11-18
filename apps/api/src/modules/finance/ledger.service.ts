import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import { addPesewas, todayInAccra, type Pesewas } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import type { LedgerService, StudentBalance } from '../../common/contracts';
import { ageBalance, currentAndArrears, splitBalance, withRunningBalance, type AgingBuckets } from './domain';
import { FinanceStore, toIso } from './finance-store';
import { fullName } from './support';

interface TermRow { id: string; start_date: string; end_date: string; name: string }

/**
 * Read side of the student sub-ledgers. Single-student figures always read ledger_entries directly;
 * mv_student_balances is refreshed in the background for list screens.
 */
@Injectable()
export class LedgerServiceImpl implements LedgerService, OnApplicationShutdown {
  private readonly logger = new Logger('LedgerService');
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(KYSELY) private readonly db: Db, private readonly store: FinanceStore) {}

  private conn(tx?: unknown): Db | Tx {
    return (tx as Tx | undefined) ?? this.db;
  }

  async terms(db: Db | Tx = this.db): Promise<{ terms: TermRow[]; currentIndex: number }> {
    const terms = (await db.selectFrom('terms').select(['id', 'start_date', 'end_date', 'name']).orderBy('start_date').execute()).map((t) => ({ ...t, start_date: String(t.start_date), end_date: String(t.end_date) }));
    const today = todayInAccra();
    let currentIndex = terms.findIndex((t) => t.start_date <= today && t.end_date >= today);
    if (currentIndex < 0) {
      // between terms: the latest term that has started counts as current
      currentIndex = terms.reduce((acc, t, i) => (t.start_date <= today ? i : acc), terms.length - 1);
    }
    return { terms, currentIndex };
  }

  async aging(studentIds: string[] | null, db: Db | Tx = this.db): Promise<Map<string, { balance: Pesewas; buckets: AgingBuckets }>> {
    const { terms, currentIndex } = await this.terms(db);
    const idx = new Map(terms.map((t, i) => [t.id, i]));
    let bq = db.selectFrom('ledger_entries').select(['student_id', sql<string>`sum(amount_pesewas)`.as('b')]).groupBy('student_id');
    if (studentIds) bq = studentIds.length ? bq.where('student_id', 'in', studentIds) : bq.where(sql<boolean>`false`);
    const balances = await bq.execute();
    // net charges per term (everything except payments and their reversals)
    let cq = db.selectFrom('ledger_entries as le').leftJoin('ledger_entries as orig', 'orig.id', 'le.reverses_entry_id')
      .select(['le.student_id', 'le.term_id', sql<string>`sum(le.amount_pesewas)`.as('c')])
      .where('le.term_id', 'is not', null)
      .where('le.entry_type', '<>', 'payment')
      .where((eb) => eb.or([eb('orig.entry_type', 'is', null), eb('orig.entry_type', '<>', 'payment')]))
      .groupBy(['le.student_id', 'le.term_id']);
    if (studentIds) cq = studentIds.length ? cq.where('le.student_id', 'in', studentIds) : cq.where(sql<boolean>`false`);
    const charges = await cq.execute();
    const byStudent = new Map<string, Array<{ termId: string; termIndex: number; chargedPesewas: Pesewas }>>();
    for (const c of charges) {
      const arr = byStudent.get(c.student_id) ?? [];
      arr.push({ termId: c.term_id!, termIndex: idx.get(c.term_id!) ?? 0, chargedPesewas: Number(c.c) });
      byStudent.set(c.student_id, arr);
    }
    const out = new Map<string, { balance: Pesewas; buckets: AgingBuckets }>();
    for (const b of balances) {
      const bal = Number(b.b);
      out.set(b.student_id, { balance: bal, buckets: ageBalance(bal, byStudent.get(b.student_id) ?? [], currentIndex) });
    }
    return out;
  }

  async balance(studentId: string, tx?: unknown): Promise<StudentBalance> {
    const db = this.conn(tx);
    const a = (await this.aging([studentId], db)).get(studentId);
    const bal = a?.balance ?? 0;
    const ca = a ? currentAndArrears(a.buckets) : { currentTermOutstandingPesewas: 0, arrearsPesewas: 0 };
    const last = await db.selectFrom('payments').select((eb) => eb.fn.max('received_at').as('m')).where('student_id', '=', studentId).where('status', '=', 'confirmed').executeTakeFirst();
    return {
      studentId,
      balancePesewas: bal,
      currentTermOutstandingPesewas: ca.currentTermOutstandingPesewas,
      arrearsPesewas: ca.arrearsPesewas,
      creditPesewas: splitBalance(bal).creditPesewas,
      lastPaymentAt: last?.m ? toIso(last.m) : null,
    };
  }

  /** Amount owed per student (0 when settled or in credit). One query for the whole batch. */
  async outstandingByStudent(studentIds: string[], tx?: unknown): Promise<Map<string, Pesewas>> {
    const out = new Map<string, Pesewas>(studentIds.map((id) => [id, 0]));
    if (studentIds.length === 0) return out;
    const rows = await this.conn(tx).selectFrom('ledger_entries').select(['student_id', sql<string>`sum(amount_pesewas)`.as('b')])
      .where('student_id', 'in', studentIds).groupBy('student_id').execute();
    for (const r of rows) out.set(r.student_id, Math.max(0, Number(r.b)));
    return out;
  }

  async termCollectionSummary(termId: string): Promise<{ billedPesewas: Pesewas; collectedPesewas: Pesewas; outstandingPesewas: Pesewas }> {
    const s = await this.termFigures(this.db, termId);
    return { billedPesewas: s.billedPesewas, collectedPesewas: s.collectedPesewas, outstandingPesewas: s.outstandingPesewas };
  }

  async termFigures(db: Db | Tx, termId: string, classId?: string) {
    let billedQ = db.selectFrom('invoices').select((eb) => eb.fn.coalesce(eb.fn.sum<string>('total_pesewas'), eb.val('0')).as('s')).where('term_id', '=', termId).where('status', '=', 'issued');
    let paidQ = db.selectFrom('payment_allocations as pa').innerJoin('invoice_lines as il', 'il.id', 'pa.invoice_line_id').innerJoin('invoices as i', 'i.id', 'il.invoice_id')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('pa.amount_pesewas'), eb.val('0')).as('s')).where('i.term_id', '=', termId).where('i.status', '=', 'issued');
    let adjQ = db.selectFrom('ledger_entries as le').select((eb) => eb.fn.coalesce(eb.fn.sum<string>('le.amount_pesewas'), eb.val('0')).as('s'))
      .where('le.term_id', '=', termId).where((eb) => eb.or([eb('le.entry_type', '=', 'adjustment'), eb.and([eb('le.entry_type', '=', 'reversal'), eb('le.adjustment_id', 'is not', null)])]));
    if (classId) {
      billedQ = billedQ.where('class_id', '=', classId);
      paidQ = paidQ.where('i.class_id', '=', classId);
      adjQ = adjQ.where('le.student_id', 'in', db.selectFrom('invoices').select('student_id').where('term_id', '=', termId).where('class_id', '=', classId));
    }
    const [b, p, a] = await Promise.all([billedQ.executeTakeFirstOrThrow(), paidQ.executeTakeFirstOrThrow(), adjQ.executeTakeFirstOrThrow()]);
    const billed = Number(b.s);
    const collected = Number(p.s);
    const adjustments = Number(a.s); // signed: negative = discounts/waivers
    return { billedPesewas: billed, collectedPesewas: collected, adjustmentsPesewas: adjustments, outstandingPesewas: Math.max(0, billed - collected + adjustments) };
  }

  async ledger(studentId: string) {
    if (!(await this.store.studentExists(this.db, studentId))) throw AppError.notFound('student');
    const rows = await this.db.selectFrom('ledger_entries as le').leftJoin('terms as t', 't.id', 'le.term_id').leftJoin('payments as p', 'p.id', 'le.payment_id')
      .select(['le.id', 'le.entry_no', 'le.posted_at', 'le.term_id', 't.name as term_name', 'le.entry_type', 'le.amount_pesewas', 'le.description', 'le.invoice_line_id', 'le.payment_id', 'le.adjustment_id', 'le.reverses_entry_id', 'p.receipt_no'])
      .where('le.student_id', '=', studentId).orderBy('le.entry_no').execute();
    const entries = withRunningBalance(rows.map((r) => ({
      id: r.id, entryNo: Number(r.entry_no), postedAt: toIso(r.posted_at), termId: r.term_id, termName: r.term_name, entryType: r.entry_type,
      amountPesewas: Number(r.amount_pesewas), description: r.description, invoiceLineId: r.invoice_line_id, paymentId: r.payment_id,
      adjustmentId: r.adjustment_id, reversesEntryId: r.reverses_entry_id, receiptNo: r.receipt_no,
    })));
    return { studentId, balancePesewas: entries.length ? entries[entries.length - 1]!.runningBalancePesewas : 0, entries };
  }

  async guardianBalance(guardianId: string) {
    const g = await this.db.selectFrom('guardians').select(['id', 'first_name', 'last_name']).where('id', '=', guardianId).executeTakeFirst();
    if (!g) throw AppError.notFound('guardian');
    const kids = await this.db.selectFrom('student_guardians as sg').innerJoin('students as s', 's.id', 'sg.student_id')
      .select(['s.id', 's.student_code', 's.first_name', 's.middle_names', 's.last_name', 's.status'])
      .where('sg.guardian_id', '=', guardianId).where('sg.is_fee_payer', '=', true).orderBy('s.date_of_birth').execute();
    const children = await Promise.all(kids.map(async (k) => ({ studentCode: k.student_code, studentName: fullName(k.first_name, k.middle_names, k.last_name), status: k.status, ...(await this.balance(k.id)) })));
    return {
      guardianId, guardianName: `${g.first_name} ${g.last_name}`,
      totalBalancePesewas: addPesewas(0, ...children.map((c) => c.balancePesewas)),
      totalOwedPesewas: addPesewas(0, ...children.map((c) => Math.max(0, c.balancePesewas))),
      totalCreditPesewas: addPesewas(0, ...children.map((c) => c.creditPesewas)),
      children,
    };
  }

  async classBalances(termId?: string) {
    const { terms, currentIndex } = await this.terms();
    const term = termId ? terms.find((t) => t.id === termId) : terms[currentIndex];
    if (!term) return { termId: termId ?? null, data: [] };
    const classes = await this.db.selectFrom('invoices as i').innerJoin('classes as c', 'c.id', 'i.class_id').select(['c.id', 'c.display_name']).distinct()
      .where('i.term_id', '=', term.id).where('i.status', '=', 'issued').orderBy('c.display_name').execute();
    const data = [];
    for (const c of classes) {
      const f = await this.termFigures(this.db, term.id, c.id);
      const students = await this.db.selectFrom('invoices').select('student_id').where('term_id', '=', term.id).where('class_id', '=', c.id).where('status', '=', 'issued').execute();
      const owed = await this.outstandingByStudent(students.map((s) => s.student_id));
      data.push({
        classId: c.id, className: c.display_name, students: students.length, billedPesewas: f.billedPesewas, paidPesewas: f.collectedPesewas,
        adjustmentsPesewas: f.adjustmentsPesewas, outstandingPesewas: f.outstandingPesewas,
        totalOwedAllTermsPesewas: addPesewas(0, ...owed.values()), studentsOwing: [...owed.values()].filter((v) => v > 0).length,
      });
    }
    return { termId: term.id, termName: term.name, data };
  }

  async schoolBalance() {
    const rows = await this.db.selectFrom('ledger_entries').select(['student_id', sql<string>`sum(amount_pesewas)`.as('b')]).groupBy('student_id').execute();
    const bals = rows.map((r) => Number(r.b));
    const { terms, currentIndex } = await this.terms();
    const current = terms[currentIndex];
    return {
      totalOwedPesewas: addPesewas(0, ...bals.filter((b) => b > 0)),
      totalCreditPesewas: addPesewas(0, ...bals.filter((b) => b < 0).map((b) => -b)),
      netBalancePesewas: addPesewas(0, ...bals),
      studentsOwing: bals.filter((b) => b > 0).length,
      studentsInCredit: bals.filter((b) => b < 0).length,
      currentTerm: current ? { termId: current.id, termName: current.name, ...(await this.termFigures(this.db, current.id)) } : null,
    };
  }

  /** Debounced background refresh of mv_student_balances after money writes. Never blocks a request. */
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshNow().catch((err) => this.logger.error({ err }, 'mv_student_balances refresh failed'));
    }, 2000);
    this.refreshTimer.unref();
  }

  async refreshNow(): Promise<void> {
    await sql`select app.refresh_student_balances()`.execute(this.db);
  }

  onApplicationShutdown(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}
