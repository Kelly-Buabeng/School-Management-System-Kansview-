/**
 * In-memory reference model of one student's sub-ledger, built only from the pure domain functions.
 * Used by property-based tests; the database services follow the same steps inside one transaction.
 */
import type { Pesewas } from '@sms/shared';
import {
  adjustmentEntry, allocatePayment, assertWithinLimit, balanceOf, chargeEntry, lineReductions, netAllocations,
  paymentEntry, planCreditReconciliation, reversalEntry, reversalRows, splitBalance,
  type AdjustmentType, type Allocation, type CreditSource, type LedgerEntryType, type LineState, type OutstandingLine,
} from '../index';
import { isCreditAdjustment } from '../ledger';

interface Line { id: string; invoiceId: string; termIndex: number; feeItemId: string; priority: number; seq: number; amount: Pesewas }
interface Invoice { id: string; termIndex: number; lineIds: string[]; status: 'issued' | 'void' }
interface Payment { id: string; seq: number; amount: Pesewas; status: 'confirmed' | 'reversed' }
interface AllocRow { paymentId: string; invoiceLineId: string | null; amount: Pesewas }
interface Adjustment { id: string; termIndex: number; feeItemId: string | null; type: AdjustmentType; amount: Pesewas; status: 'approved' | 'reversed' }
interface Entry { id: number; type: LedgerEntryType; amount: Pesewas; ref: string; reverses?: number }

export class FinanceBook {
  lines: Line[] = [];
  invoices: Invoice[] = [];
  payments: Payment[] = [];
  allocs: AllocRow[] = [];
  adjustments: Adjustment[] = [];
  ledger: Entry[] = [];
  private n = 0;
  private nextId(p: string): string { return `${p}${++this.n}`; }
  private post(type: LedgerEntryType, amount: Pesewas, ref: string, reverses?: number): void {
    this.ledger.push({ id: this.ledger.length + 1, type, amount, ref, reverses });
  }

  balance(): Pesewas { return balanceOf(this.ledger.map((e) => ({ amountPesewas: e.amount }))); }

  private liveLines(): Line[] {
    const live = new Set(this.invoices.filter((i) => i.status === 'issued').flatMap((i) => i.lineIds));
    return this.lines.filter((l) => live.has(l.id));
  }

  private allocatedOn(lineId: string): Pesewas {
    return this.allocs.filter((a) => a.invoiceLineId === lineId).reduce((s, a) => s + a.amount, 0);
  }

  private reductions(): Map<string, Pesewas> {
    const out = new Map<string, Pesewas>();
    const live = this.liveLines();
    const terms = new Set(live.map((l) => l.termIndex));
    for (const t of terms) {
      const tl = live.filter((l) => l.termIndex === t).map((l) => ({ invoiceLineId: l.id, feeItemId: l.feeItemId, amountPesewas: l.amount, allocationPriority: l.priority, sequence: l.seq }));
      const adj = this.adjustments.filter((a) => a.status === 'approved' && a.termIndex === t && isCreditAdjustment(a.type)).map((a) => ({ feeItemId: a.feeItemId, creditPesewas: a.amount }));
      for (const [k, v] of lineReductions(tl, adj)) out.set(k, v);
    }
    return out;
  }

  lineStates(): LineState[] {
    const red = this.reductions();
    return this.liveLines().map((l) => ({
      invoiceLineId: l.id, termKey: l.termIndex, allocationPriority: l.priority, sequence: l.seq,
      outstandingPesewas: l.amount - this.allocatedOn(l.id) - (red.get(l.id) ?? 0),
      paidBy: this.payments.map((p) => ({ paymentId: p.id, receivedAt: String(p.seq).padStart(8, '0'), receiptNo: p.id, amountPesewas: this.allocs.filter((a) => a.paymentId === p.id && a.invoiceLineId === l.id).reduce((s, a) => s + a.amount, 0) })).filter((x) => x.amountPesewas !== 0),
    }));
  }

  outstandingLines(): OutstandingLine[] {
    return this.lineStates().map((l) => ({ ...l, outstandingPesewas: Math.max(0, l.outstandingPesewas) }));
  }

  unallocatedOf(paymentId: string): Pesewas {
    return this.allocs.filter((a) => a.paymentId === paymentId && a.invoiceLineId === null).reduce((s, a) => s + a.amount, 0);
  }

  private creditSources(): CreditSource[] {
    return this.payments.filter((p) => p.status === 'confirmed').map((p) => ({ paymentId: p.id, receivedAt: String(p.seq).padStart(8, '0'), receiptNo: p.id, unallocatedPesewas: this.unallocatedOf(p.id) }));
  }

  reconcile(): void {
    for (const m of planCreditReconciliation(this.lineStates(), this.creditSources(), this.balance())) {
      this.allocs.push({ paymentId: m.paymentId, invoiceLineId: m.invoiceLineId, amount: m.amountPesewas });
    }
  }

  invoice(termIndex: number, items: Array<{ feeItemId: string; priority: number; amount: Pesewas }>): string | null {
    if (this.invoices.some((i) => i.termIndex === termIndex && i.status === 'issued')) return null; // skip already invoiced
    const id = this.nextId('inv');
    const inv: Invoice = { id, termIndex, lineIds: [], status: 'issued' };
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.feeItemId) || it.amount <= 0) continue;
      seen.add(it.feeItemId);
      const line: Line = { id: this.nextId('line'), invoiceId: id, termIndex, feeItemId: it.feeItemId, priority: it.priority, seq: this.n, amount: it.amount };
      this.lines.push(line);
      inv.lineIds.push(line.id);
      this.post('invoice_charge', chargeEntry(it.amount), line.id);
    }
    this.invoices.push(inv);
    this.reconcile();
    return id;
  }

  pay(amount: Pesewas, explicit?: Allocation[]): string {
    const res = allocatePayment(amount, this.outstandingLines(), explicit);
    const id = this.nextId('pay');
    this.payments.push({ id, seq: this.n, amount, status: 'confirmed' });
    for (const a of res.allocations) this.allocs.push({ paymentId: id, invoiceLineId: a.invoiceLineId, amount: a.amountPesewas });
    if (res.unallocatedPesewas > 0) this.allocs.push({ paymentId: id, invoiceLineId: null, amount: res.unallocatedPesewas });
    this.post('payment', paymentEntry(amount), id);
    return id;
  }

  reversePayment(paymentId: string): void {
    const p = this.payments.find((x) => x.id === paymentId);
    if (!p || p.status !== 'confirmed') throw new Error('not reversible');
    const rows = this.allocs.filter((a) => a.paymentId === paymentId).map((a) => ({ invoiceLineId: a.invoiceLineId, amountPesewas: a.amount }));
    for (const r of reversalRows(rows)) this.allocs.push({ paymentId, invoiceLineId: r.invoiceLineId, amount: r.amountPesewas });
    const orig = this.ledger.find((e) => e.type === 'payment' && e.ref === paymentId)!;
    this.post('reversal', reversalEntry(orig.amount), paymentId, orig.id);
    p.status = 'reversed';
    this.reconcile();
  }

  /** Approves and posts an adjustment; throws (like the service) when over the limit. */
  adjust(type: AdjustmentType, termIndex: number, feeItemId: string | null, amount: Pesewas): string {
    const states = this.lineStates();
    const live = this.liveLines();
    const target = states.filter((s) => {
      const l = live.find((x) => x.id === s.invoiceLineId)!;
      return l.termIndex === termIndex && (feeItemId === null || l.feeItemId === feeItemId);
    });
    const targetOwed = target.reduce((s, x) => s + Math.max(0, x.outstandingPesewas), 0);
    assertWithinLimit(type, amount, { targetOwedPesewas: targetOwed, creditPesewas: splitBalance(this.balance()).creditPesewas });
    const id = this.nextId('adj');
    this.adjustments.push({ id, termIndex, feeItemId, type, amount, status: 'approved' });
    this.post('adjustment', adjustmentEntry(type, amount), id);
    this.reconcile();
    return id;
  }

  reverseAdjustment(adjId: string): void {
    const a = this.adjustments.find((x) => x.id === adjId);
    if (!a || a.status !== 'approved') throw new Error('not reversible');
    const orig = this.ledger.find((e) => e.type === 'adjustment' && e.ref === adjId)!;
    this.post('reversal', reversalEntry(orig.amount), adjId, orig.id);
    a.status = 'reversed';
    this.reconcile();
  }

  /** Void is blocked while money is allocated to the invoice's lines. Returns false when blocked. */
  voidInvoice(invoiceId: string): boolean {
    const inv = this.invoices.find((i) => i.id === invoiceId);
    if (!inv || inv.status !== 'issued') return false;
    if (inv.lineIds.some((l) => this.allocatedOn(l) !== 0)) return false;
    for (const lid of inv.lineIds) {
      const orig = this.ledger.find((e) => e.type === 'invoice_charge' && e.ref === lid)!;
      this.post('reversal', reversalEntry(orig.amount), lid, orig.id);
    }
    inv.status = 'void';
    this.reconcile();
    return true;
  }

  netAllocationsOf(paymentId: string) {
    return netAllocations(this.allocs.filter((a) => a.paymentId === paymentId).map((a) => ({ invoiceLineId: a.invoiceLineId, amountPesewas: a.amount })));
  }
}
