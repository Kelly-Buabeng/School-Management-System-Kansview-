/**
 * Adapters between what the real API returns today and the shapes the screens use.
 * Each accepts BOTH shapes (the mock API keeps the frontend's original assumption), so the UI works in either mode.
 * The differences are listed in docs/contracts/change-requests/CR-0008-e-frontend-response-shape-alignment.md.
 */
import type {
  AcademicYear,
  Adjustment,
  AuditEvent,
  CashUp,
  ClassInfo,
  DashboardData,
  FeeItem,
  LedgerEntry,
  PaymentMethod,
  StudentGuardianLink,
  Term,
  Withdrawal,
  ClearanceItem,
} from './types';

type Loose = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : undefined);

/** Lists come either as `{ data: [...] }` or as a bare array. */
export function listOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { data?: unknown }).data)) return (r as { data: T[] }).data;
  return [];
}

export function normTerm(t: Loose, yearName?: string): Term {
  return {
    id: String(t.id),
    academicYearId: String(t.academicYearId ?? ''),
    name: str(t.name) ?? `Term ${t.number}`,
    number: (num(t.number) ?? 1) as 1 | 2 | 3,
    startDate: str(t.startDate) ?? '',
    endDate: str(t.endDate) ?? '',
    isCurrent: t.isCurrent === true || t.status === 'current',
    ...(yearName ? {} : {}),
  };
}

export function normYear(y: Loose): AcademicYear {
  const id = String(y.id);
  return {
    id,
    name: str(y.name) ?? '',
    startDate: str(y.startDate) ?? '',
    endDate: str(y.endDate) ?? '',
    isCurrent: y.isCurrent === true || y.status === 'current',
    terms: listOf<Loose>(y.terms).map((t) => ({ ...normTerm(t), academicYearId: id })),
  };
}

export function normClass(c: Loose): ClassInfo {
  return {
    id: String(c.id),
    name: str(c.name) ?? str(c.displayName) ?? '',
    levelId: String(c.levelId ?? ''),
    levelName: str(c.levelName) ?? '',
    academicYearId: String(c.academicYearId ?? ''),
    capacity: num(c.capacity) ?? 0,
    enrolledCount: num(c.enrolledCount) ?? 0,
    classTeacherName: str(c.classTeacherName) ?? null,
    stream: str(c.stream) ?? null,
  };
}

/** Student guardian links: nested `{ guardian, relationship… }` or flat guardian rows with the link flags. */
export function normGuardianLinks(r: unknown): StudentGuardianLink[] {
  return listOf<Loose>(r).map((l) => {
    if (l.guardian && typeof l.guardian === 'object') return l as unknown as StudentGuardianLink;
    const id = String(l.id ?? l.guardianId);
    return {
      guardian: {
        id,
        fullName: str(l.fullName) ?? [l.title, l.firstName, l.lastName].filter(Boolean).join(' '),
        phonePrimary: str(l.phonePrimary),
        phoneSecondary: str(l.phoneSecondary),
        email: str(l.email),
        version: num(l.version),
      },
      relationship: str(l.relationship) ?? '',
      isPrimary: Boolean(l.isPrimary),
      isFeePayer: Boolean(l.isFeePayer),
      canPickUp: Boolean(l.canPickUp),
      receivesSms: Boolean(l.receivesSms),
    };
  });
}

/** Ledger entries: debit/credit columns, or one signed `amountPesewas` (positive = charge). */
export function normLedgerEntry(e: Loose): LedgerEntry {
  const signed = num(e.amountPesewas);
  return {
    id: String(e.id),
    postedAt: str(e.postedAt) ?? '',
    entryType: (str(e.entryType) ?? 'adjustment') as LedgerEntry['entryType'],
    description: str(e.description) ?? '',
    reference: str(e.reference) ?? str(e.receiptNo) ?? undefined,
    debitPesewas: num(e.debitPesewas) ?? (signed !== undefined ? Math.max(0, signed) : 0),
    creditPesewas: num(e.creditPesewas) ?? (signed !== undefined ? Math.max(0, -signed) : 0),
    runningBalancePesewas: num(e.runningBalancePesewas) ?? 0,
  };
}

export function normFeeItem(i: Loose): FeeItem {
  return {
    id: String(i.id),
    name: str(i.name) ?? '',
    category: (str(i.category) ?? 'other') as FeeItem['category'],
    optional: Boolean(i.optional ?? i.isOptional),
    priority: num(i.priority) ?? num(i.allocationPriority) ?? 99,
    active: Boolean(i.active ?? i.isActive ?? true),
  };
}

export function normAdjustment(a: Loose): Adjustment {
  return { ...(a as unknown as Adjustment), requestedById: str(a.requestedById) ?? '', decidedBy: str(a.decidedBy) ?? str(a.approvedBy), decidedAt: str(a.decidedAt) ?? str(a.approvedAt) };
}

export function normAudit(e: Loose): AuditEvent {
  return {
    id: String(e.id),
    at: str(e.at) ?? str(e.occurredAt) ?? '',
    actorName: str(e.actorName) ?? 'System',
    action: str(e.action) ?? '',
    entityType: str(e.entityType) ?? '',
    entityId: str(e.entityId),
    summary: str(e.summary) ?? [str(e.entityType), str(e.reason)].filter(Boolean).join(' — '),
    ip: str(e.ip),
  };
}

export function normCashUp(c: Loose): CashUp {
  return {
    id: String(c.id),
    businessDate: str(c.businessDate) ?? '',
    status: (str(c.status) ?? 'open') as CashUp['status'],
    expected: (c.expected ?? c.expectedByMethod ?? {}) as Partial<Record<PaymentMethod, number>>,
    counted: (c.counted ?? c.countedByMethod ?? undefined) as CashUp['counted'],
    variancePesewas: num(c.variancePesewas),
    note: str(c.note) ?? str(c.notes),
    paymentCount: num(c.paymentCount) ?? 0,
    closedBy: str(c.closedBy),
  };
}

const ITEMS: ClearanceItem[] = ['fees', 'books', 'uniform', 'property', 'library'];
export function normWithdrawal(w: Loose): Withdrawal {
  const clearance = Array.isArray(w.clearance)
    ? Object.fromEntries(ITEMS.map((k) => {
        const c = (w.clearance as Loose[]).find((x) => x.item === k);
        return [k, { cleared: Boolean(c?.cleared), by: str(c?.by), at: str(c?.at) }];
      }))
    : (w.clearance as Withdrawal['clearance']);
  const student = (w.student as Withdrawal['student'] | undefined) ?? { id: str(w.studentId), fullName: str(w.studentName), studentCode: str(w.studentCode), className: str(w.className) };
  const status = str(w.status) ?? 'pending_clearance';
  return {
    id: String(w.id),
    student,
    reason: str(w.reason) ?? '',
    kind: (str(w.kind) ?? (w.type === 'transfer_out' || w.type === 'transfer' ? 'transfer_out' : 'withdrawal')) as Withdrawal['kind'],
    destinationSchool: str(w.destinationSchool),
    status: (status === 'pending' || status === 'in_progress' ? 'pending_clearance' : status) as Withdrawal['status'],
    balancePesewas: num(w.balancePesewas) ?? num(w.feeBalancePesewas) ?? 0,
    clearance: clearance as Withdrawal['clearance'],
    startedAt: str(w.startedAt) ?? str(w.createdAt) ?? '',
  };
}

/** Dashboard: the API nests widgets under `widgets: { finance, enrolmentByClass, … }`. */
export function normDashboard(d: Loose): DashboardData {
  if (Array.isArray(d.widgets)) return d as unknown as DashboardData;
  const w = (d.widgets ?? {}) as Loose;
  const out: DashboardData = { widgets: Object.keys(w) };
  const fin = w.finance as Loose | undefined;
  if (fin) {
    out.collection = { termName: str(fin.termName) ?? '', collectedPesewas: num(fin.collectedPesewas) ?? 0, targetPesewas: num(fin.billedPesewas) ?? 0 };
    out.arrears = { totalPesewas: num(fin.outstandingPesewas) ?? 0, studentCount: num(fin.studentsOwing) ?? 0, topClasses: [] };
  }
  const enr = w.enrolmentByClass as Loose | undefined;
  if (enr) out.enrolmentByClass = listOf<Loose>(enr.classes ?? enr).map((c) => ({ className: str(c.className) ?? str(c.displayName) ?? str(c.name) ?? '', count: num(c.count) ?? num(c.enrolledCount) ?? 0, capacity: num(c.capacity) ?? 0 }));
  if (Array.isArray(w.upcomingBirthdays) || Array.isArray(w.birthdays))
    out.birthdays = listOf<Loose>(w.upcomingBirthdays ?? w.birthdays).map((b) => ({ studentId: String(b.studentId), fullName: str(b.fullName) ?? str(b.name) ?? '', className: str(b.className) ?? '', date: str(b.date) ?? str(b.birthday) ?? '', turning: num(b.turning) ?? 0 }));
  if (Array.isArray(w.attendanceTrend)) out.attendanceTrend = listOf<Loose>(w.attendanceTrend).map((p) => ({ date: str(p.date) ?? '', ratePercent: num(p.ratePercent) ?? 0 }));
  return out;
}
