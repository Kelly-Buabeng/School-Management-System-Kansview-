/**
 * Shared database helpers for the finance module. Every money write goes through a transaction (`Tx`) and these helpers.
 * The ledger is append-only: nothing here updates or deletes ledger entries, allocations or invoice lines.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addPesewas, todayInAccra, type Pesewas } from '@sms/shared';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import {
  isCreditAdjustment, lineReductions, planCreditReconciliation,
  type AdjustmentType, type CreditSource, type LedgerEntryType, type LineState, type OutstandingLine,
} from './domain';

export type DbOrTx = Db | Tx;

export interface LedgerInsert {
  studentId: string;
  termId: string | null;
  entryType: LedgerEntryType;
  amountPesewas: Pesewas;
  invoiceLineId?: string | null;
  paymentId?: string | null;
  adjustmentId?: string | null;
  reversesEntryId?: string | null;
  description: string;
  postedBy: string;
}

export interface AllocationInsert {
  paymentId: string;
  invoiceLineId: string | null;
  amountPesewas: Pesewas;
  allocationBatchId: string;
  /** Informational: the DB requires is_reversal = (amount < 0), so the flag is derived from the sign. */
  isReversal?: boolean;
  createdBy: string;
}

export interface DetailedLine extends LineState {
  invoiceId: string;
  invoiceNo: string;
  termId: string;
  feeItemId: string | null;
  feeItemName: string;
  description: string;
  amountPesewas: Pesewas;
  paidPesewas: Pesewas;
  reductionPesewas: Pesewas;
}

@Injectable()
export class FinanceStore {
  constructor(@Inject(KYSELY) readonly db: Db) {}

  /** Serialises money writes for one student (two bursars paying for the same child at once). */
  async lockStudent(tx: Tx, studentId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`finance:student:${studentId}`}, 0))`.execute(tx);
  }

  /** Gap-free document number (receipt, reversal, invoice). Must run inside the business transaction. */
  async nextDocNo(tx: Tx, docType: 'receipt' | 'reversal' | 'invoice'): Promise<string> {
    const r = await sql<{ no: string }>`select app.next_doc_no(${docType}) as no`.execute(tx);
    return r.rows[0]!.no;
  }

  async newBatchId(tx: DbOrTx): Promise<string> {
    const r = await sql<{ id: string }>`select app.uuid_v7() as id`.execute(tx);
    return r.rows[0]!.id;
  }

  async studentExists(db: DbOrTx, studentId: string): Promise<boolean> {
    const r = await db.selectFrom('students').select('id').where('id', '=', studentId).executeTakeFirst();
    return !!r;
  }

  async postLedger(tx: Tx, entries: LedgerInsert[]): Promise<Array<{ id: string; amountPesewas: Pesewas }>> {
    if (entries.length === 0) return [];
    const rows = await tx
      .insertInto('ledger_entries')
      .values(entries.map((e) => ({
        student_id: e.studentId,
        term_id: e.termId,
        entry_type: e.entryType,
        amount_pesewas: e.amountPesewas,
        invoice_line_id: e.invoiceLineId ?? null,
        payment_id: e.paymentId ?? null,
        adjustment_id: e.adjustmentId ?? null,
        reverses_entry_id: e.reversesEntryId ?? null,
        description: e.description,
        posted_by: e.postedBy,
      })))
      .returning(['id', 'amount_pesewas'])
      .execute();
    return rows.map((r) => ({ id: r.id, amountPesewas: Number(r.amount_pesewas) }));
  }

  async insertAllocations(tx: Tx, rows: AllocationInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await tx
      .insertInto('payment_allocations')
      .values(rows.map((r) => ({
        payment_id: r.paymentId,
        invoice_line_id: r.invoiceLineId,
        amount_pesewas: r.amountPesewas,
        allocation_batch_id: r.allocationBatchId,
        is_reversal: r.amountPesewas < 0,
        created_by: r.createdBy,
      })))
      .execute();
  }

  async balance(db: DbOrTx, studentId: string): Promise<Pesewas> {
    const r = await db
      .selectFrom('ledger_entries')
      .select(sql<string>`coalesce(sum(amount_pesewas), 0)`.as('b'))
      .where('student_id', '=', studentId)
      .executeTakeFirstOrThrow();
    return Number(r.b);
  }

  /** Every line on the student's issued invoices with exact outstanding (after allocations and adjustment reductions). */
  async lineStates(db: DbOrTx, studentId: string): Promise<DetailedLine[]> {
    const lines = await db
      .selectFrom('invoice_lines as il')
      .innerJoin('invoices as i', 'i.id', 'il.invoice_id')
      .leftJoin('fee_items as fi', 'fi.id', 'il.fee_item_id')
      .innerJoin('terms as t', 't.id', 'i.term_id')
      .select([
        'il.id', 'il.invoice_id', 'il.fee_item_id', 'il.description', 'il.amount_pesewas',
        'i.invoice_no', 'i.term_id', 't.start_date', 'fi.name as fee_item_name', 'il.allocation_priority',
      ])
      .where('i.student_id', '=', studentId)
      .where('i.status', '=', 'issued')
      .orderBy('t.start_date')
      .orderBy('i.invoice_no')
      .orderBy('il.id')
      .execute();
    if (lines.length === 0) return [];
    const lineIds = lines.map((l) => l.id);
    const paid = await db
      .selectFrom('payment_allocations as pa')
      .innerJoin('payments as p', 'p.id', 'pa.payment_id')
      .select(['pa.invoice_line_id', 'pa.payment_id', 'p.receipt_no', 'p.received_at', sql<string>`sum(pa.amount_pesewas)`.as('amt')])
      .where('pa.invoice_line_id', 'in', lineIds)
      .groupBy(['pa.invoice_line_id', 'pa.payment_id', 'p.receipt_no', 'p.received_at'])
      .execute();
    const adjustments = await db
      .selectFrom('adjustments')
      .select(['term_id', 'fee_item_id', 'type', 'amount_pesewas', 'approved_at'])
      .where('student_id', '=', studentId)
      .where('status', '=', 'approved')
      .orderBy('approved_at')
      .orderBy('id')
      .execute();

    const reductions = new Map<string, Pesewas>();
    const termIds = [...new Set(lines.map((l) => l.term_id))];
    for (const termId of termIds) {
      const tl = lines.filter((l) => l.term_id === termId).map((l, i) => ({
        invoiceLineId: l.id, feeItemId: l.fee_item_id ?? `line:${l.id}`, amountPesewas: Number(l.amount_pesewas), allocationPriority: l.allocation_priority, sequence: i,
      }));
      const adj = adjustments
        .filter((a) => a.term_id === termId && isCreditAdjustment(a.type as AdjustmentType))
        .map((a) => ({ feeItemId: a.fee_item_id, creditPesewas: Number(a.amount_pesewas) }));
      for (const [k, v] of lineReductions(tl, adj)) reductions.set(k, v);
    }

    return lines.map((l, i) => {
      const by = paid.filter((p) => p.invoice_line_id === l.id).map((p) => ({
        paymentId: p.payment_id, receivedAt: toIso(p.received_at), receiptNo: p.receipt_no, amountPesewas: Number(p.amt),
      })).filter((p) => p.amountPesewas !== 0);
      const paidPesewas = addPesewas(0, ...by.map((b) => b.amountPesewas));
      const amount = Number(l.amount_pesewas);
      const reduction = reductions.get(l.id) ?? 0;
      return {
        invoiceLineId: l.id,
        invoiceId: l.invoice_id,
        invoiceNo: l.invoice_no,
        termId: l.term_id,
        termKey: `${toDate(l.start_date)}|${l.term_id}`,
        allocationPriority: l.allocation_priority,
        sequence: `${l.invoice_no}|${String(i).padStart(4, '0')}`,
        feeItemId: l.fee_item_id,
        feeItemName: l.fee_item_name ?? l.description,
        description: l.description,
        amountPesewas: amount,
        paidPesewas,
        reductionPesewas: reduction,
        outstandingPesewas: amount - paidPesewas - reduction,
        paidBy: by,
      };
    });
  }

  toOutstanding(lines: readonly DetailedLine[]): OutstandingLine[] {
    return lines.map((l) => ({ invoiceLineId: l.invoiceLineId, termKey: l.termKey, allocationPriority: l.allocationPriority, sequence: l.sequence, outstandingPesewas: Math.max(0, l.outstandingPesewas) }));
  }

  /** Confirmed payments of the student with money not tied to any line. */
  async creditSources(db: DbOrTx, studentId: string): Promise<CreditSource[]> {
    const rows = await db
      .selectFrom('payments as p')
      .innerJoin('payment_allocations as pa', 'pa.payment_id', 'p.id')
      .select(['p.id', 'p.receipt_no', 'p.received_at', sql<string>`sum(pa.amount_pesewas)`.as('amt')])
      .where('p.student_id', '=', studentId)
      .where('p.status', '=', 'confirmed')
      .where('pa.invoice_line_id', 'is', null)
      .groupBy(['p.id', 'p.receipt_no', 'p.received_at'])
      .execute();
    return rows
      .map((r) => ({ paymentId: r.id, receiptNo: r.receipt_no, receivedAt: toIso(r.received_at), unallocatedPesewas: Number(r.amt) }))
      .filter((r) => r.unallocatedPesewas > 0);
  }

  /**
   * Keeps line-level allocations consistent with the ledger: gives back over-paid line money and applies free credit to
   * outstanding lines (oldest first). Appends allocation rows only. Returns the credit applied to lines.
   */
  async reconcileCredit(tx: Tx, studentId: string, actorId: string): Promise<Pesewas> {
    const [lines, sources, balance] = await Promise.all([this.lineStates(tx, studentId), this.creditSources(tx, studentId), this.balance(tx, studentId)]);
    const moves = planCreditReconciliation(lines, sources, balance);
    if (moves.length === 0) return 0;
    const batch = await this.newBatchId(tx);
    await this.insertAllocations(tx, moves.map((m) => ({ paymentId: m.paymentId, invoiceLineId: m.invoiceLineId, amountPesewas: m.amountPesewas, allocationBatchId: batch, isReversal: false, createdBy: actorId })));
    return moves.filter((m) => m.invoiceLineId !== null && m.amountPesewas > 0).reduce((s, m) => s + m.amountPesewas, 0);
  }

  async setting<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
    const r = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
    return r ? (r.value as T) : fallback;
  }

  /** The term that contains `date` (Accra), else the current term, else null. */
  async termForDate(db: DbOrTx, date: string = todayInAccra()): Promise<string | null> {
    const t = await db.selectFrom('terms').select('id').where('start_date', '<=', date).where('end_date', '>=', date).orderBy('start_date', 'desc').executeTakeFirst();
    return t?.id ?? null;
  }
}

export function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
export function toDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
