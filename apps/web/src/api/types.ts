/**
 * Types used by the web app.
 *
 * Where packages/contracts/openapi.yaml defines a schema we use it directly (Schemas[...]).
 * Many Phase 0 responses are only described as "OK"; for those the shapes below are the frontend's
 * assumption, recorded in docs/contracts/change-requests/CR-0003-e-frontend-assumed-response-shapes.md
 * so the owning backend agents can confirm or correct them.
 */
import type { Schemas } from '@sms/contracts';

export type Problem = Schemas['Problem'];
export type Role = Schemas['Role'];
export type Me = Schemas['Me'] & { username?: string; mustChangePassword?: boolean };
export type LoginResponse = Schemas['LoginResponse'];
export type StudentStatus = Schemas['StudentStatus'];
export type StudentSummary = Schemas['StudentSummary'];
export type Student = Schemas['Student'] & { classId?: string; levelId?: string };
export type Enrolment = Schemas['Enrolment'];
export type Guardian = Schemas['Guardian'];
export type GuardianInput = Schemas['GuardianInput'];
export type StudentMedical = Schemas['StudentMedical'];
export type StudentMedicalInput = Schemas['StudentMedicalInput'];
export type EmergencyContactInput = Schemas['EmergencyContactInput'];
export type AdmitStudentRequest = Schemas['AdmitStudentRequest'];
export type PaymentMethod = Schemas['PaymentMethod'];
export type RecordPaymentRequest = Schemas['RecordPaymentRequest'];
export type Payment = Schemas['Payment'] & { studentName?: string; studentCode?: string; payerName?: string; idempotencyKey?: string };
export type Invoice = Schemas['Invoice'] & { studentName?: string; termName?: string };
export type Balance = Schemas['Balance'];
export type GenerateInvoicesRequest = Schemas['GenerateInvoicesRequest'];
export type AdjustmentRequest = Schemas['AdjustmentRequest'];
export type SendMessageRequest = Schemas['SendMessageRequest'];
export type SearchResults = Schemas['SearchResults'];

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListResponse<T> {
  data: T[];
}

// ---------- academic setup ----------
export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  terms: Term[];
}
export interface Term {
  id: string;
  academicYearId: string;
  name: string;
  number: 1 | 2 | 3;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}
export interface Level {
  id: string;
  name: string;
  order: number;
}
export interface ClassInfo {
  id: string;
  name: string;
  levelId: string;
  levelName: string;
  academicYearId: string;
  capacity: number;
  enrolledCount: number;
  classTeacherName?: string | null;
  stream?: string | null;
}
export interface ClassStudent extends StudentSummary {
  gender?: 'male' | 'female';
  dateOfBirth?: string;
}
export interface Subject {
  id: string;
  name: string;
  code: string;
}
export interface GradingBand {
  grade: string;
  minScore: number;
  maxScore: number;
  remark: string;
}
export interface GradingScale {
  id: string;
  name: string;
  classWeightPercent: number;
  examWeightPercent: number;
  bands: GradingBand[];
}

// ---------- students ----------
export interface DuplicateCandidate {
  id: string;
  studentCode: string;
  fullName: string;
  dateOfBirth: string;
  className?: string;
  guardianPhone?: string;
  matchReasons: string[];
}
export interface StudentGuardianLink {
  guardian: Guardian;
  relationship: string;
  isPrimary: boolean;
  isFeePayer: boolean;
  canPickUp: boolean;
  receivesSms: boolean;
}
export interface StudentDocument {
  id: string;
  docType: 'birth_certificate' | 'previous_report' | 'passport_photo' | 'other';
  fileName: string;
  uploadedAt: string;
  scanStatus: 'pending' | 'clean' | 'infected';
  fileId?: string;
  notes?: string;
}
export interface Incident {
  id: string;
  studentId: string;
  occurredOn: string;
  category: string;
  description: string;
  actionTaken?: string;
  recordedBy: string;
}
export interface EmergencyContact {
  priority: number;
  name: string;
  relationship: string;
  phones: string[];
  telLinks: string[];
}
export interface AuthorisedPickup {
  id: string;
  name: string;
  relationship: string;
  phone?: string;
  photoUrl?: string | null;
  notes?: string;
}
export type ContactOutcome = 'reached' | 'no_answer' | 'wrong_number' | 'message_left';
export interface EmergencyContactLog {
  id: string;
  at: string;
  byName: string;
  contactName: string;
  phone: string;
  outcome: ContactOutcome;
  notes?: string;
}
export interface EmergencyViewData {
  student: StudentSummary & { className?: string };
  bloodGroup?: string;
  alertSummary?: string;
  allergies?: string;
  contacts: EmergencyContact[];
  authorisedPickups: AuthorisedPickup[];
  doctor?: { name?: string; clinic?: string; phone?: string };
  recentContactLog: EmergencyContactLog[];
}
export interface AttendanceSummaryRow {
  studentId?: string;
  classId?: string;
  name: string;
  present: number;
  absent: number;
  late: number;
  ratePercent: number;
}

// ---------- promotion / withdrawals ----------
export type PromotionAction = 'promote' | 'repeat' | 'skip' | 'withdraw' | 'transfer_out' | 'graduate';
export interface PromotionItem {
  id: string;
  student: StudentSummary;
  fromClassName?: string;
  action: PromotionAction;
  targetClassId: string | null;
  targetClassName?: string | null;
  outstandingPesewas: number;
  arrearsFlag: boolean;
  overrideReason?: string;
}
export interface PromotionRun {
  id: string;
  status: 'draft' | 'committed' | 'undone';
  fromAcademicYearId: string;
  toAcademicYearId: string;
  arrearsPolicy: 'off' | 'warn' | 'block';
  undoDeadline: string | null;
  createdAt?: string;
  items: PromotionItem[];
}
export type ClearanceItem = 'fees' | 'books' | 'uniform' | 'property' | 'library';
export interface Withdrawal {
  id: string;
  student: StudentSummary;
  reason: string;
  kind: 'withdrawal' | 'transfer_out';
  destinationSchool?: string;
  status: 'pending_clearance' | 'completed' | 'cancelled';
  balancePesewas: number;
  clearance: Record<ClearanceItem, { cleared: boolean; by?: string; at?: string; note?: string }>;
  startedAt: string;
}

// ---------- attendance & academics ----------
export type AttendanceMark = 'present' | 'absent' | 'late' | 'excused';
export interface AttendanceRegister {
  classId: string;
  date: string;
  taken: boolean;
  entries: { studentId: string; fullName: string; rollNumber?: number; status: AttendanceMark; reason?: string }[];
}
export interface ScoreSheet {
  classId: string;
  termId: string;
  subjectId: string;
  locked: boolean;
  classMax: number;
  examMax: number;
  rows: { studentId: string; fullName: string; rollNumber?: number; classScore: number | null; examScore: number | null }[];
}
export interface ReportCard {
  id: string;
  studentId: string;
  studentName: string;
  className: string;
  termId: string;
  status: 'draft' | 'published';
  position?: number;
  average?: number;
  teacherRemark?: string;
  headRemark?: string;
  conduct?: string;
  interest?: string;
}

// ---------- finance ----------
export interface FeeItem {
  id: string;
  name: string;
  category: 'tuition' | 'feeding' | 'transport' | 'books' | 'uniform' | 'other';
  optional: boolean;
  priority: number;
  active: boolean;
}
export interface FeeStructure {
  id: string;
  termId: string;
  termName?: string;
  levelId: string;
  levelName?: string;
  status: 'draft' | 'active' | 'archived';
  lines: { feeItemId: string; feeItemName?: string; amountPesewas: number }[];
  totalPesewas: number;
}
export interface InvoicePreview {
  dryRun: boolean;
  studentCount: number;
  totalPesewas: number;
  skippedAlreadyInvoiced: number;
  problems: { studentId?: string; studentName?: string; message: string }[];
  sample: { studentName: string; className: string; totalPesewas: number; broughtForwardPesewas: number }[];
  jobId?: string;
}
export interface LedgerEntry {
  id: string;
  postedAt: string;
  entryType: 'charge' | 'payment' | 'discount' | 'waiver' | 'refund' | 'reversal' | 'opening_balance' | 'adjustment' | 'credit';
  description: string;
  reference?: string;
  debitPesewas: number;
  creditPesewas: number;
  runningBalancePesewas: number;
}
export interface Ledger {
  studentId: string;
  entries: LedgerEntry[];
  balancePesewas: number;
}
export interface Adjustment {
  id: string;
  studentId: string;
  studentName: string;
  termId: string;
  type: AdjustmentRequest['type'];
  amountPesewas?: number;
  percentBasisPoints?: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'reversed';
  requestedBy: string;
  requestedById: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
}
export interface CashUp {
  id: string;
  businessDate: string;
  status: 'open' | 'closed';
  expected: Partial<Record<PaymentMethod, number>>;
  counted?: Partial<Record<PaymentMethod, number>>;
  variancePesewas?: number;
  note?: string;
  paymentCount: number;
  closedBy?: string;
}
export interface GuardianBalance {
  guardianId: string;
  totalPesewas: number;
  children: { studentId: string; fullName: string; studentCode: string; className?: string; balancePesewas: number }[];
}
export interface PaymentDuplicateMatch {
  paymentId: string;
  receiptNo: string;
  studentName: string;
  studentCode?: string;
  amountPesewas: number;
  receivedAt: string;
}
export interface ReportRow {
  [key: string]: string | number | null;
}
export interface ReportResult {
  columns: { key: string; label: string; money?: boolean }[];
  rows: ReportRow[];
  totals?: ReportRow;
}

// ---------- messages / imports ----------
export interface MessageTemplate {
  id: string;
  name: string;
  kind: SendMessageRequest['kind'];
  body: string;
}
export interface MessagePreview {
  recipientCount: number;
  segmentsPerMessage: number;
  encoding: 'GSM-7' | 'Unicode';
  estimatedCostPesewas: number;
  samples: string[];
  needsApproval: boolean;
}
export interface MessageSummary {
  id: string;
  kind: SendMessageRequest['kind'];
  bodyPreview: string;
  audienceLabel: string;
  status: 'awaiting_approval' | 'queued' | 'sending' | 'sent' | 'partly_failed' | 'failed';
  createdAt: string;
  createdBy: string;
  recipientCount: number;
  delivered: number;
  failed: number;
}
export interface MessageRecipient {
  id: string;
  guardianName: string;
  phone: string;
  studentName?: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'opted_out';
  error?: string;
  updatedAt: string;
}
export type ImportType = 'students_guardians' | 'staff' | 'opening_balances';
export interface ImportJob {
  id: string;
  type: ImportType;
  fileName: string;
  status: 'uploaded' | 'validating' | 'validated' | 'committing' | 'committed' | 'failed';
  totals: { rows: number; valid: number; warnings: number; errors: number; duplicates: number; committed?: number };
  createdAt: string;
  createdBy: string;
}
export interface ImportRow {
  rowNumber: number;
  status: 'valid' | 'warning' | 'error' | 'duplicate';
  data: Record<string, string>;
  messages: string[];
  resolution?: 'link_existing' | 'create_new' | 'skip' | null;
  duplicateOf?: { id: string; label: string } | null;
}

// ---------- dashboard / staff / users / audit / settings ----------
export interface DashboardData {
  widgets: string[];
  enrolmentByClass?: { className: string; count: number; capacity: number }[];
  collection?: { termName: string; collectedPesewas: number; targetPesewas: number };
  arrears?: { totalPesewas: number; studentCount: number; topClasses: { className: string; outstandingPesewas: number }[] };
  attendanceTrend?: { date: string; ratePercent: number }[];
  birthdays?: { studentId: string; fullName: string; className: string; date: string; turning: number }[];
  todayPayments?: { count: number; totalPesewas: number };
}
export interface StaffMember {
  id: string;
  fullName: string;
  jobTitle: string;
  phone?: string;
  email?: string;
  status: 'active' | 'archived';
  ghanaCardLast4?: string;
  ssnitLast4?: string;
  assignments?: { classId: string; className: string; subjectName?: string; isClassTeacher: boolean }[];
}
export interface UserAccount {
  id: string;
  username: string;
  fullName: string;
  roles: Role[];
  status: 'active' | 'disabled' | 'locked';
  mfaEnabled: boolean;
  lastLoginAt?: string | null;
}
export interface AuditEvent {
  id: string;
  at: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
  ip?: string;
}
export interface SchoolProfile {
  name: string;
  schoolCode: string;
  motto?: string;
  address?: string;
  phone?: string;
  email?: string;
  logoUrl?: string | null;
  version?: number;
}
export interface Policies {
  arrearsPromotionPolicy: 'off' | 'warn' | 'block';
  absenceSmsEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  bulkApprovalThreshold: number;
  reversalSameDayOnly: boolean;
  promotionUndoDays: number;
  version?: number;
}
