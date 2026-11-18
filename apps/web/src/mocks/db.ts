/**
 * In-memory fake database for the mock API. All people are FAKE (random combinations of common Ghanaian names).
 * Phone numbers use only the +23324000xxxx test range. Deterministic (seeded) so tests are stable.
 */
import { formatStudentCode } from '@sms/shared';
import type { Role } from '@/auth/permissions';
import type {
  Adjustment,
  AttendanceMark,
  AuditEvent,
  CashUp,
  ContactOutcome,
  FeeItem,
  FeeStructure,
  GradingScale,
  ImportJob,
  ImportRow,
  MessageRecipient,
  MessageSummary,
  MessageTemplate,
  PaymentMethod,
  Policies,
  PromotionRun,
  ReportCard,
  SchoolProfile,
  StaffMember,
  StudentDocument,
  StudentStatus,
  Incident,
  Withdrawal,
} from '@/api/types';

// ---------- seeded random ----------
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
/** Deterministic UUID-shaped ids (v4 layout) so URLs look real. */
export function uid(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function testPhone(n: number) {
  return `+23324000${String(n % 10000).padStart(4, '0')}`;
}

const AVATAR_COLOURS = ['#1c4f8a', '#7a3e9d', '#0f766e', '#9a3412', '#3f6212', '#be123c'];
/** Small inline SVG "photo" (initials) so no real photos or external images are needed. */
export function avatar(name: string, i = 0): string {
  const ini = name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${AVATAR_COLOURS[i % AVATAR_COLOURS.length]}"/><text x="48" y="60" font-size="36" font-family="Arial" text-anchor="middle" fill="#fff">${ini}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ---------- types ----------
export interface MUser {
  id: string;
  username: string;
  password: string;
  fullName: string;
  roles: Role[];
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  status: 'active' | 'disabled' | 'locked';
  failedLogins: number;
  lastLoginAt: string | null;
  staffId?: string;
}
export interface MLevel { id: string; name: string; order: number; levelGroup: 'KG' | 'PRIMARY' | 'JHS' }
export interface MClass { id: string; name: string; levelId: string; academicYearId: string; capacity: number; classTeacherId?: string; stream?: string | null }
export interface MYear { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean }
export interface MTerm { id: string; academicYearId: string; name: string; number: 1 | 2 | 3; startDate: string; endDate: string; isCurrent: boolean }
export interface MMedical {
  bloodGroup?: string;
  allergies?: string;
  chronicConditions?: string;
  medicationNotes?: string;
  specialNeeds?: string;
  doctorName?: string;
  clinicName?: string;
  clinicPhone?: string;
  alertSummary?: string;
  updatedAt: string;
}
export interface MEmergencyContact { priority: number; guardianId?: string; name: string; relationship: string; phone: string; notes?: string }
export interface MEnrolment { id: string; studentId: string; classId: string; rollNumber: number; startDate: string; endDate: string | null; status: string }
export interface MStudent {
  id: string;
  studentCode: string;
  firstName: string;
  middleNames?: string;
  lastName: string;
  preferredName?: string;
  dateOfBirth: string;
  gender: 'male' | 'female';
  status: StudentStatus;
  nationality: string;
  homeAddress: string;
  previousSchool?: string;
  admissionDate: string;
  admissionClassId: string;
  religion?: string;
  languages: string[];
  birthCertNo?: string;
  photoUrl: string;
  medical: MMedical | null;
  emergencyContacts: MEmergencyContact[];
  version: number;
  archived: boolean;
}
export interface MGuardian {
  id: string;
  title?: string;
  firstName: string;
  lastName: string;
  phonePrimary: string;
  phoneSecondary?: string;
  whatsappNumber?: string;
  email?: string;
  occupation?: string;
  workplace?: string;
  homeAddress?: string;
  workAddress?: string;
  ghanaCard?: string;
  version: number;
}
export interface MLink { studentId: string; guardianId: string; relationship: string; isPrimary: boolean; isFeePayer: boolean; canPickUp: boolean; receivesSms: boolean }
export interface MPickup { id: string; studentId: string; name: string; relationship: string; phone?: string; photoUrl: string | null; notes?: string; archived: boolean }
export interface MContactLog { id: string; studentId: string; at: string; byName: string; contactName: string; phone: string; outcome: ContactOutcome; notes?: string }
export interface MInvoiceLine { id: string; feeItemId: string; feeItemName: string; priority: number; amountPesewas: number; paidPesewas: number }
export interface MInvoice { id: string; invoiceNo: string; studentId: string; termId: string; status: 'issued' | 'void'; issueDate: string; openingBalancePesewas: number; adjustmentsPesewas: number; lines: MInvoiceLine[] }
export interface MLedger { id: string; studentId: string; postedAt: string; entryType: string; description: string; reference?: string; amountPesewas: number }
export interface MPayment {
  id: string;
  receiptNo: string;
  studentId: string;
  amountPesewas: number;
  method: PaymentMethod;
  referenceNo?: string;
  status: 'confirmed' | 'reversed';
  source: 'manual';
  receivedAt: string;
  recordedBy: string;
  recordedById: string;
  payerName?: string;
  payerGuardianId?: string;
  notes?: string;
  allocations: { invoiceLineId: string | null; feeItemName: string; amountPesewas: number }[];
  creditCreatedPesewas: number;
  balanceAfterPesewas: number;
  reversal: { reversedAt: string; reversedBy: string; reason: string; reversalNo: string } | null;
  pendingReversal?: { requestedBy: string; reason: string; at: string } | null;
  idempotencyKey?: string;
  hasAttachment?: boolean;
}

export interface Db {
  users: MUser[];
  school: SchoolProfile;
  policies: Policies;
  years: MYear[];
  terms: MTerm[];
  levels: MLevel[];
  classes: MClass[];
  subjects: { id: string; name: string; code: string }[];
  gradingScales: GradingScale[];
  students: MStudent[];
  enrolments: MEnrolment[];
  guardians: MGuardian[];
  links: MLink[];
  pickups: MPickup[];
  contactLogs: MContactLog[];
  documents: (StudentDocument & { studentId: string })[];
  incidents: Incident[];
  staff: StaffMember[];
  feeItems: FeeItem[];
  feeStructures: FeeStructure[];
  invoices: MInvoice[];
  ledger: MLedger[];
  payments: MPayment[];
  adjustments: Adjustment[];
  cashUps: CashUp[];
  attendance: Map<string, { studentId: string; status: AttendanceMark; reason?: string }[]>;
  scores: Map<string, { studentId: string; classScore: number | null; examScore: number | null }[]>;
  lockedTerms: Set<string>;
  reportCards: ReportCard[];
  promotionRuns: (PromotionRun & { classIds: string[]; snapshot?: { enrolments: MEnrolment[]; statuses: Record<string, StudentStatus> } })[];
  withdrawals: Withdrawal[];
  templates: MessageTemplate[];
  messages: (MessageSummary & { body: string })[];
  recipients: Map<string, MessageRecipient[]>;
  imports: ImportJob[];
  importRows: Map<string, ImportRow[]>;
  audit: AuditEvent[];
  counters: { receipt: number; reversal: number; invoice: number; studentSeq: Record<number, number> };
  idempotency: Map<string, { bodyHash: string; status: number; body: unknown }>;
}

// ---------- name pools (fake) ----------
const MALE = ['Kwame', 'Kofi', 'Kwabena', 'Kwaku', 'Yaw', 'Kwesi', 'Kojo', 'Abdulai', 'Ebo', 'Nii', 'Fiifi', 'Selorm', 'Elikem', 'Mawuli', 'Yusif', 'Emmanuel', 'Daniel', 'Samuel'];
const FEMALE = ['Akosua', 'Ama', 'Abena', 'Akua', 'Yaa', 'Afua', 'Esi', 'Adwoa', 'Efua', 'Naa', 'Dzifa', 'Selasi', 'Mariam', 'Fatima', 'Zainab', 'Aisha', 'Grace', 'Priscilla'];
const SURNAMES = ['Mensah', 'Owusu', 'Boateng', 'Tetteh', 'Iddrisu', 'Asante', 'Osei', 'Appiah', 'Agyemang', 'Addo', 'Ofori', 'Darko', 'Quaye', 'Lartey', 'Amoah', 'Danquah', 'Acheampong', 'Sarpong', 'Antwi', 'Frimpong', 'Adjei', 'Ansah', 'Yeboah', 'Amponsah', 'Bonsu', 'Gyamfi', 'Annan', 'Abubakar', 'Fuseini', 'Agbeko'];
const AREAS = ['Kaneshie', 'Dansoman', 'Adenta', 'Madina', 'Tema Comm. 25', 'Kasoa', 'Achimota', 'Spintex', 'Lapaz', 'Haatso', 'Dome', 'Teshie'];
const JOBS = ['Trader', 'Teacher', 'Nurse', 'Driver', 'Civil servant', 'Seamstress', 'Mechanic', 'Accountant', 'Farmer', 'Banker', 'Pharmacist', 'Caterer'];

export const KNOWN = {
  /** Reference already used on a seeded MoMo payment (for the duplicate warning demo). */
  momoReference: '61234567890',
  password: 'password123',
  mfaCode: '123456',
};

export function createDb(seed = 20261117): Db {
  idCounter = 0;
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)]!;
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  let phoneN = 100;
  const nextPhone = () => testPhone(phoneN++);

  const db: Db = {
    users: [],
    school: {
      name: 'Kansview School',
      schoolCode: 'KSV',
      motto: 'Knowledge and Service',
      address: 'P.O. Box KN 1234, Kaneshie, Accra',
      phone: testPhone(1),
      email: 'office@kansview.example',
      logoUrl: null,
      version: 1,
    },
    policies: {
      arrearsPromotionPolicy: 'warn',
      absenceSmsEnabled: true,
      quietHoursStart: '20:00',
      quietHoursEnd: '07:00',
      bulkApprovalThreshold: 50,
      reversalSameDayOnly: true,
      promotionUndoDays: 14,
      version: 1,
    },
    years: [],
    terms: [],
    levels: [],
    classes: [],
    subjects: [],
    gradingScales: [],
    students: [],
    enrolments: [],
    guardians: [],
    links: [],
    pickups: [],
    contactLogs: [],
    documents: [],
    incidents: [],
    staff: [],
    feeItems: [],
    feeStructures: [],
    invoices: [],
    ledger: [],
    payments: [],
    adjustments: [],
    cashUps: [],
    attendance: new Map(),
    scores: new Map(),
    lockedTerms: new Set(),
    reportCards: [],
    promotionRuns: [],
    withdrawals: [],
    templates: [],
    messages: [],
    recipients: new Map(),
    imports: [],
    importRows: new Map(),
    audit: [],
    counters: { receipt: 0, reversal: 0, invoice: 0, studentSeq: {} },
    idempotency: new Map(),
  };

  // ---------- academic setup ----------
  const prevYear: MYear = { id: uid(), name: '2025/2026', startDate: '2025-09-09', endDate: '2026-07-24', isCurrent: false };
  const curYear: MYear = { id: uid(), name: '2026/2027', startDate: '2026-09-08', endDate: '2027-07-23', isCurrent: true };
  const nextYear: MYear = { id: uid(), name: '2027/2028', startDate: '2027-09-07', endDate: '2028-07-21', isCurrent: false };
  db.years.push(prevYear, curYear, nextYear);
  const termDates: Record<string, [string, string][]> = {
    [prevYear.id]: [['2025-09-09', '2025-12-19'], ['2026-01-13', '2026-04-02'], ['2026-04-28', '2026-07-24']],
    [curYear.id]: [['2026-09-08', '2026-12-18'], ['2027-01-12', '2027-04-01'], ['2027-04-27', '2027-07-23']],
    [nextYear.id]: [['2027-09-07', '2027-12-17'], ['2028-01-11', '2028-03-31'], ['2028-04-25', '2028-07-21']],
  };
  for (const y of db.years) {
    termDates[y.id]!.forEach(([s, e], i) => {
      db.terms.push({ id: uid(), academicYearId: y.id, name: `Term ${i + 1}`, number: (i + 1) as 1 | 2 | 3, startDate: s, endDate: e, isCurrent: y.isCurrent && i === 0 });
    });
  }
  const levelNames: [string, MLevel['levelGroup']][] = [
    ['KG 1', 'KG'], ['KG 2', 'KG'], ['Basic 1', 'PRIMARY'], ['Basic 2', 'PRIMARY'], ['Basic 3', 'PRIMARY'], ['Basic 4', 'PRIMARY'],
    ['Basic 5', 'PRIMARY'], ['Basic 6', 'PRIMARY'], ['JHS 1', 'JHS'], ['JHS 2', 'JHS'], ['JHS 3', 'JHS'],
  ];
  levelNames.forEach(([name, group], i) => db.levels.push({ id: uid(), name, order: i + 1, levelGroup: group }));
  for (const year of [curYear, nextYear]) {
    for (const lvl of db.levels) {
      const streams = lvl.name === 'Basic 1' ? ['A', 'B'] : [null];
      for (const s of streams) {
        db.classes.push({ id: uid(), name: s ? `${lvl.name}${s}` : lvl.name, levelId: lvl.id, academicYearId: year.id, capacity: lvl.name === 'Basic 2' ? 10 : 14, stream: s });
      }
    }
  }
  ['English Language', 'Mathematics', 'Integrated Science', 'Social Studies', 'Ghanaian Language (Twi)', 'Religious & Moral Education', 'Creative Arts', 'Computing'].forEach((n) =>
    db.subjects.push({ id: uid(), name: n, code: n.replace(/[^A-Z]/g, '').slice(0, 4) || n.slice(0, 3).toUpperCase() }),
  );
  db.gradingScales.push({
    id: uid(),
    name: 'Basic school (9 bands)',
    classWeightPercent: 30,
    examWeightPercent: 70,
    bands: [
      { grade: '1', minScore: 80, maxScore: 100, remark: 'Highest' },
      { grade: '2', minScore: 70, maxScore: 79, remark: 'Higher' },
      { grade: '3', minScore: 65, maxScore: 69, remark: 'High' },
      { grade: '4', minScore: 60, maxScore: 64, remark: 'High average' },
      { grade: '5', minScore: 55, maxScore: 59, remark: 'Average' },
      { grade: '6', minScore: 50, maxScore: 54, remark: 'Low average' },
      { grade: '7', minScore: 45, maxScore: 49, remark: 'Low' },
      { grade: '8', minScore: 40, maxScore: 44, remark: 'Lower' },
      { grade: '9', minScore: 0, maxScore: 39, remark: 'Lowest' },
    ],
  });

  // ---------- staff & users ----------
  const staffSeed: [string, string, Role[] | null, string, boolean][] = [
    ['Abena Darko', 'Administrator', ['ADMIN'], 'admin', true],
    ['Yaw Boateng', 'Bursar', ['BURSAR'], 'bursar', true],
    ['Esi Tetteh', 'Headteacher', ['HEADTEACHER'], 'head', false],
    ['Abdulai Iddrisu', 'Registrar', ['REGISTRAR'], 'registrar', false],
    ['Kofi Asante', 'Class teacher, Basic 2', ['TEACHER'], 'teacher', false],
    ['Akua Frimpong', 'Front office clerk', ['REGISTRAR'], 'newclerk', false],
    ['Efua Quaye', 'Class teacher, KG 2', null, '', false],
    ['Nii Lartey', 'Mathematics teacher (JHS)', null, '', false],
    ['Selasi Agbeko', 'Science teacher (JHS)', null, '', false],
  ];
  staffSeed.forEach(([fullName, jobTitle, roles, username, mfa], i) => {
    const staff: StaffMember = { id: uid(), fullName, jobTitle, phone: testPhone(20 + i), status: 'active', ghanaCardLast4: String(1000 + i * 37).slice(-4), ssnitLast4: String(2000 + i * 53).slice(-4), assignments: [] };
    db.staff.push(staff);
    if (roles) {
      db.users.push({
        id: uid(),
        username,
        password: KNOWN.password,
        fullName,
        roles,
        mfaEnabled: mfa,
        mustChangePassword: username === 'newclerk',
        status: 'active',
        failedLogins: 0,
        lastLoginAt: '2026-11-16T07:45:00Z',
        staffId: staff.id,
      });
    }
  });
  const curClasses = db.classes.filter((c) => c.academicYearId === curYear.id);
  const basic2 = curClasses.find((c) => c.name === 'Basic 2')!;
  const kg2 = curClasses.find((c) => c.name === 'KG 2')!;
  const teacherStaff = db.staff.find((s) => s.fullName === 'Kofi Asante')!;
  basic2.classTeacherId = teacherStaff.id;
  teacherStaff.assignments = [{ classId: basic2.id, className: basic2.name, isClassTeacher: true }];
  const efua = db.staff.find((s) => s.fullName === 'Efua Quaye')!;
  kg2.classTeacherId = efua.id;
  efua.assignments = [{ classId: kg2.id, className: kg2.name, isClassTeacher: true }];

  // ---------- finance setup ----------
  const fi = (name: string, category: FeeItem['category'], optional: boolean, priority: number): FeeItem => ({ id: uid(), name, category, optional, priority, active: true });
  const tuition = fi('Tuition', 'tuition', false, 1);
  const books = fi('Books and stationery', 'books', false, 2);
  const pta = fi('PTA levy', 'other', false, 3);
  const feeding = fi('Feeding', 'feeding', true, 4);
  const transport = fi('School bus', 'transport', true, 5);
  db.feeItems.push(tuition, books, pta, feeding, transport);
  const curTerm = db.terms.find((t) => t.isCurrent)!;
  const tuitionFor = (lvl: MLevel) => (lvl.levelGroup === 'KG' ? 120000 : lvl.levelGroup === 'PRIMARY' ? 150000 : 180000);
  for (const lvl of db.levels) {
    const lines = [
      { feeItemId: tuition.id, feeItemName: tuition.name, amountPesewas: tuitionFor(lvl) },
      { feeItemId: books.id, feeItemName: books.name, amountPesewas: 25000 },
      { feeItemId: pta.id, feeItemName: pta.name, amountPesewas: 5000 },
      { feeItemId: feeding.id, feeItemName: feeding.name, amountPesewas: 60000 },
      { feeItemId: transport.id, feeItemName: transport.name, amountPesewas: 45000 },
    ];
    db.feeStructures.push({ id: uid(), termId: curTerm.id, termName: `${curYear.name} ${curTerm.name}`, levelId: lvl.id, levelName: lvl.name, status: 'active', lines, totalPesewas: lines.reduce((a, l) => a + l.amountPesewas, 0) });
  }
  const nextTerm = db.terms.find((t) => t.academicYearId === curYear.id && t.number === 2)!;
  const draftLvl = db.levels[0]!;
  db.feeStructures.push({
    id: uid(),
    termId: nextTerm.id,
    termName: `${curYear.name} ${nextTerm.name}`,
    levelId: draftLvl.id,
    levelName: draftLvl.name,
    status: 'draft',
    lines: [
      { feeItemId: tuition.id, feeItemName: tuition.name, amountPesewas: 125000 },
      { feeItemId: books.id, feeItemName: books.name, amountPesewas: 15000 },
    ],
    totalPesewas: 140000,
  });

  // ---------- students & guardians ----------
  const addGuardian = (firstName: string, lastName: string, title: string): MGuardian => {
    const g: MGuardian = {
      id: uid(),
      title,
      firstName,
      lastName,
      phonePrimary: nextPhone(),
      phoneSecondary: rnd() < 0.4 ? nextPhone() : undefined,
      occupation: pick(JOBS),
      workplace: rnd() < 0.5 ? `${pick(AREAS)} Market` : undefined,
      homeAddress: `House ${int(1, 99)}, ${pick(AREAS)}, Accra`,
      ghanaCard: `GHA-${String(int(100000000, 999999999))}-${int(0, 9)}`,
      version: 1,
    };
    db.guardians.push(g);
    return g;
  };

  const nextCode = (year: number) => {
    db.counters.studentSeq[year] = (db.counters.studentSeq[year] ?? 0) + 1;
    return formatStudentCode('KSV', year, db.counters.studentSeq[year]!);
  };

  const addStudent = (opts: { firstName: string; lastName: string; gender: 'male' | 'female'; dob: string; cls: MClass; admissionYear: number; medical?: MMedical | null; middleNames?: string }) => {
    const s: MStudent = {
      id: uid(),
      studentCode: nextCode(opts.admissionYear),
      firstName: opts.firstName,
      middleNames: opts.middleNames,
      lastName: opts.lastName,
      dateOfBirth: opts.dob,
      gender: opts.gender,
      status: 'active',
      nationality: 'Ghanaian',
      homeAddress: `House ${int(1, 99)}, ${pick(AREAS)}, Accra`,
      previousSchool: rnd() < 0.3 ? 'Little Stars Preparatory' : undefined,
      admissionDate: `${opts.admissionYear}-09-0${int(1, 9)}`,
      admissionClassId: opts.cls.id,
      religion: pick(['Christian', 'Muslim', 'Christian', 'Christian']),
      languages: pick([['English', 'Twi'], ['English', 'Ga'], ['English', 'Ewe'], ['English', 'Dagbani'], ['English', 'Fante']]),
      birthCertNo: `BC/${opts.admissionYear - 5}/${int(10000, 99999)}`,
      photoUrl: avatar(`${opts.firstName} ${opts.lastName}`, db.students.length),
      medical: opts.medical ?? null,
      emergencyContacts: [],
      version: 1,
      archived: false,
    };
    db.students.push(s);
    const roll = db.enrolments.filter((e) => e.classId === opts.cls.id && !e.endDate).length + 1;
    db.enrolments.push({ id: uid(), studentId: s.id, classId: opts.cls.id, rollNumber: roll, startDate: curYear.startDate, endDate: null, status: 'active' });
    return s;
  };

  const link = (s: MStudent, g: MGuardian, relationship: string, primary: boolean, feePayer: boolean) => {
    db.links.push({ studentId: s.id, guardianId: g.id, relationship, isPrimary: primary, isFeePayer: feePayer, canPickUp: true, receivesSms: primary });
  };

  // The well-known family used in demos and tests.
  const mother = addGuardian('Akosua', 'Owusu', 'Mrs');
  const father = addGuardian('Kofi', 'Mensah', 'Mr');
  const kwame = addStudent({
    firstName: 'Kwame',
    lastName: 'Mensah',
    middleNames: 'Agyei',
    gender: 'male',
    dob: '2018-03-12',
    cls: basic2,
    admissionYear: 2023,
    medical: {
      bloodGroup: 'O+',
      allergies: 'Peanuts (severe — anaphylaxis). Penicillin.',
      chronicConditions: 'Mild asthma',
      medicationNotes: 'EpiPen and inhaler kept in the head office, top drawer.',
      doctorName: 'Dr. Ama Ofori',
      clinicName: 'Kaneshie Family Clinic',
      clinicPhone: testPhone(9001),
      alertSummary: 'SEVERE PEANUT ALLERGY — EpiPen in head office. Asthma.',
      updatedAt: '2026-09-10T09:00:00Z',
    },
  });
  const ama = addStudent({ firstName: 'Ama', lastName: 'Mensah', gender: 'female', dob: '2021-06-02', cls: kg2, admissionYear: 2025 });
  for (const s of [kwame, ama]) {
    link(s, mother, 'Mother', true, true);
    link(s, father, 'Father', false, false);
    s.emergencyContacts = [
      { priority: 1, guardianId: mother.id, name: 'Akosua Owusu', relationship: 'Mother', phone: mother.phonePrimary },
      { priority: 2, guardianId: father.id, name: 'Kofi Mensah', relationship: 'Father', phone: father.phonePrimary },
      { priority: 3, name: 'Adwoa Owusu', relationship: 'Aunt', phone: nextPhone(), notes: 'Lives near the school' },
    ];
    db.pickups.push(
      { id: uid(), studentId: s.id, name: 'Akosua Owusu', relationship: 'Mother', phone: mother.phonePrimary, photoUrl: avatar('Akosua Owusu', 1), archived: false },
      { id: uid(), studentId: s.id, name: 'Kofi Mensah', relationship: 'Father', phone: father.phonePrimary, photoUrl: avatar('Kofi Mensah', 2), archived: false },
      { id: uid(), studentId: s.id, name: 'Yaw Darko', relationship: 'Family driver', phone: testPhone(9002), photoUrl: avatar('Yaw Darko', 3), notes: 'Weekdays only', archived: false },
    );
  }
  db.contactLogs.push({ id: uid(), studentId: kwame.id, at: '2026-10-21T10:05:00Z', byName: 'Abdulai Iddrisu', contactName: 'Akosua Owusu', phone: mother.phonePrimary, outcome: 'reached', notes: 'Mother informed about mild fever; picked up at 11:30.' });

  // Everyone else.
  for (const cls of curClasses) {
    const lvl = db.levels.find((l) => l.id === cls.levelId)!;
    const target = cls.id === basic2.id ? 10 : cls.id === kg2.id ? 8 : int(7, 11);
    const ageBase = 2026 - (4 + lvl.order);
    while (db.enrolments.filter((e) => e.classId === cls.id && !e.endDate).length < target) {
      const gender = rnd() < 0.5 ? 'male' : 'female';
      const firstName = pick(gender === 'male' ? MALE : FEMALE);
      const lastName = pick(SURNAMES);
      const dob = `${ageBase - (rnd() < 0.2 ? 1 : 0)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
      const hasAlert = rnd() < 0.12;
      const s = addStudent({
        firstName,
        lastName,
        gender,
        dob,
        cls,
        admissionYear: Math.max(2019, 2026 - lvl.order + int(0, 1) - 1),
        medical: hasAlert
          ? {
              bloodGroup: pick(['A+', 'B+', 'O+', 'O-', 'AB+']),
              allergies: pick(['Sulfa drugs', 'Shellfish', 'Dust and pollen', 'Eggs']),
              chronicConditions: pick(['Sickle cell (SS)', 'Asthma', 'Epilepsy', '']),
              alertSummary: pick(['Sickle cell — keep hydrated, call parent if pain', 'Asthma — inhaler in bag', 'Epilepsy — see care plan in office', 'Allergy — see details']),
              updatedAt: '2026-09-12T08:00:00Z',
            }
          : rnd() < 0.5
            ? { bloodGroup: pick(['A+', 'B+', 'O+', 'unknown']), updatedAt: '2026-09-12T08:00:00Z' }
            : null,
      });
      // Siblings sometimes share an existing guardian.
      const shareWith = rnd() < 0.15 ? db.guardians[int(2, Math.max(2, db.guardians.length - 1))] : undefined;
      const g1 = shareWith ?? addGuardian(pick(FEMALE), s.lastName, 'Mrs');
      link(s, g1, 'Mother', true, true);
      if (!shareWith && rnd() < 0.6) {
        const g2 = addGuardian(pick(MALE), s.lastName, 'Mr');
        link(s, g2, 'Father', false, false);
      }
      const gs = db.links.filter((l) => l.studentId === s.id).map((l) => db.guardians.find((g) => g.id === l.guardianId)!);
      s.emergencyContacts = gs.map((g, i) => ({ priority: i + 1, guardianId: g.id, name: `${g.firstName} ${g.lastName}`, relationship: db.links.find((l) => l.studentId === s.id && l.guardianId === g.id)!.relationship, phone: g.phonePrimary }));
      db.pickups.push({ id: uid(), studentId: s.id, name: `${g1.firstName} ${g1.lastName}`, relationship: 'Mother', phone: g1.phonePrimary, photoUrl: avatar(`${g1.firstName} ${g1.lastName}`, db.pickups.length), archived: false });
    }
  }
  // Roll numbers alphabetical.
  for (const cls of curClasses) {
    const ens = db.enrolments.filter((e) => e.classId === cls.id && !e.endDate);
    ens
      .map((e) => ({ e, s: db.students.find((s) => s.id === e.studentId)! }))
      .sort((a, b) => `${a.s.lastName} ${a.s.firstName}`.localeCompare(`${b.s.lastName} ${b.s.firstName}`))
      .forEach(({ e }, i) => (e.rollNumber = i + 1));
  }

  // ---------- invoices, payments, ledger ----------
  const recorder = db.users.find((u) => u.username === 'bursar')!;
  for (const s of db.students) {
    const en = db.enrolments.find((e) => e.studentId === s.id && !e.endDate)!;
    const cls = db.classes.find((c) => c.id === en.classId)!;
    const fs = db.feeStructures.find((f) => f.levelId === cls.levelId && f.termId === curTerm.id)!;
    const optIn = { feeding: rnd() < 0.6, transport: rnd() < 0.3 };
    const lines: MInvoiceLine[] = fs.lines
      .filter((l) => (l.feeItemId === feeding.id ? optIn.feeding : l.feeItemId === transport.id ? optIn.transport : true))
      .map((l) => ({ id: uid(), feeItemId: l.feeItemId, feeItemName: l.feeItemName ?? '', priority: db.feeItems.find((f) => f.id === l.feeItemId)!.priority, amountPesewas: l.amountPesewas, paidPesewas: 0 }));
    const arrears = rnd() < 0.18 ? int(2, 30) * 5000 : 0;
    if (arrears) db.ledger.push({ id: uid(), studentId: s.id, postedAt: '2026-08-01T08:00:00Z', entryType: 'opening_balance', description: 'Balance brought forward from 2025/2026', amountPesewas: arrears });
    db.counters.invoice += 1;
    const inv: MInvoice = { id: uid(), invoiceNo: `INV-${String(db.counters.invoice).padStart(6, '0')}`, studentId: s.id, termId: curTerm.id, status: 'issued', issueDate: '2026-09-01', openingBalancePesewas: arrears, adjustmentsPesewas: 0, lines };
    db.invoices.push(inv);
    for (const l of lines) db.ledger.push({ id: uid(), studentId: s.id, postedAt: '2026-09-01T08:00:00Z', entryType: 'charge', description: `${l.feeItemName} — ${curYear.name} ${curTerm.name}`, reference: inv.invoiceNo, amountPesewas: l.amountPesewas });
  }
  // Payments (chronological, so receipt numbers increase with time).
  const payPlan: { s: MStudent; amount: number; method: PaymentMethod; day: number }[] = [];
  for (const s of db.students) {
    const r = rnd();
    const total = db.invoices.find((i) => i.studentId === s.id)!.lines.reduce((a, l) => a + l.amountPesewas, 0);
    if (r < 0.25) continue;
    const parts = r < 0.6 ? 1 : 2;
    for (let i = 0; i < parts; i++) {
      const amount = r > 0.85 && parts === 1 ? total : Math.round((total * (0.3 + rnd() * 0.3)) / 1000) * 1000;
      payPlan.push({ s, amount, method: pick(['cash', 'cash', 'momo_mtn', 'momo_mtn', 'bank_transfer', 'telecel_cash'] as PaymentMethod[]), day: int(2, 75) });
    }
  }
  payPlan.sort((a, b) => a.day - b.day);
  const knownIndex = Math.min(11, payPlan.length - 1);
  payPlan.forEach((pp, i) => {
    const date = new Date(Date.UTC(2026, 8, 1) + pp.day * 86400000);
    const at = new Date(date.getTime() + int(8, 15) * 3600000 + int(0, 59) * 60000).toISOString();
    const isKnown = i === knownIndex;
    const method: PaymentMethod = isKnown ? 'momo_mtn' : pp.method;
    const ref = method === 'cash' ? undefined : isKnown ? KNOWN.momoReference : String(int(10000000000, 99999999999));
    applyPayment(db, { studentId: pp.s.id, amountPesewas: pp.amount, method, referenceNo: ref, receivedAt: at, recordedBy: recorder.fullName, recordedById: recorder.id, payerName: undefined });
  });

  // Today's cash-up (open) and yesterday's (closed).
  db.cashUps.push(
    { id: uid(), businessDate: '2026-11-16', status: 'closed', expected: { cash: 245000, momo_mtn: 180000 }, counted: { cash: 245000, momo_mtn: 180000 }, variancePesewas: 0, paymentCount: 4, closedBy: 'Yaw Boateng', note: 'All correct' },
    { id: uid(), businessDate: '2026-11-17', status: 'open', expected: {}, paymentCount: 0 },
  );

  // Adjustments queue.
  const someone = db.students[5]!;
  db.adjustments.push(
    { id: uid(), studentId: ama.id, studentName: 'Ama Mensah', termId: curTerm.id, type: 'sibling_discount', percentBasisPoints: 1000, reason: 'Second child in school (sibling of Kwame Mensah)', status: 'pending', requestedBy: 'Yaw Boateng', requestedById: recorder.id, requestedAt: '2026-11-14T10:20:00Z' },
    { id: uid(), studentId: someone.id, studentName: `${someone.firstName} ${someone.lastName}`, termId: curTerm.id, type: 'bursary', amountPesewas: 50000, reason: 'Board-approved bursary for 2026/2027', status: 'approved', requestedBy: 'Yaw Boateng', requestedById: recorder.id, requestedAt: '2026-10-02T09:00:00Z', decidedBy: 'Abena Darko', decidedAt: '2026-10-03T11:00:00Z' },
  );

  // Documents and incidents.
  db.documents.push({ id: uid(), studentId: kwame.id, docType: 'birth_certificate', fileName: 'birth-certificate.pdf', uploadedAt: '2023-09-02T10:00:00Z', scanStatus: 'clean', fileId: uid() });
  db.incidents.push({ id: uid(), studentId: kwame.id, occurredOn: '2026-10-14', category: 'Health', description: 'Mild asthma episode during PE. Used inhaler; recovered within 10 minutes.', actionTaken: 'Mother informed by phone.', recordedBy: 'Kofi Asante' });

  // Attendance history for the trend (last 10 school days, all classes).
  const days: string[] = [];
  for (let d = new Date(Date.UTC(2026, 10, 16)); days.length < 10; d = new Date(d.getTime() - 86400000)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.unshift(d.toISOString().slice(0, 10));
  }
  for (const cls of curClasses) {
    const ens = db.enrolments.filter((e) => e.classId === cls.id && !e.endDate);
    for (const day of days) {
      db.attendance.set(
        `${cls.id}|${day}`,
        ens.map((e) => ({ studentId: e.studentId, status: (rnd() < 0.93 ? 'present' : rnd() < 0.5 ? 'late' : 'absent') as AttendanceMark })),
      );
    }
  }

  // Message templates and history.
  db.templates.push(
    { id: uid(), name: 'Fee reminder', kind: 'fee_reminder', body: 'Dear {guardian_name}, {student_name} has an outstanding balance of {balance}. Kindly pay by {due_date}. Thank you. Kansview School' },
    { id: uid(), name: 'Absence alert', kind: 'absence_alert', body: 'Dear {guardian_name}, {student_name} was absent from school today ({date}). Please contact the school office.' },
    { id: uid(), name: 'School closure', kind: 'closure_notice', body: 'Dear Parent, school will close early today at {time} because of {reason}. Kansview School' },
    { id: uid(), name: 'PTA meeting', kind: 'announcement', body: 'Dear Parent, the PTA meeting is on {date} at {time} in the school hall. Kansview School' },
  );
  const msgId = uid();
  db.messages.push({ id: msgId, kind: 'announcement', body: 'Dear Parent, the PTA meeting is on Saturday 7 November at 9:00 in the school hall. Kansview School', bodyPreview: 'Dear Parent, the PTA meeting is on Saturday 7 November…', audienceLabel: 'Whole school', status: 'sent', createdAt: '2026-11-02T09:00:00Z', createdBy: 'Esi Tetteh', recipientCount: 6, delivered: 5, failed: 1 });
  db.recipients.set(
    msgId,
    db.guardians.slice(0, 6).map((g, i) => ({ id: uid(), guardianName: `${g.firstName} ${g.lastName}`, phone: g.phonePrimary, status: i === 3 ? 'failed' : 'delivered', error: i === 3 ? 'Handset unreachable' : undefined, updatedAt: '2026-11-02T09:01:00Z' })),
  );

  // Report cards (draft) for Basic 2 current term.
  for (const e of db.enrolments.filter((x) => x.classId === basic2.id && !x.endDate)) {
    const s = db.students.find((x) => x.id === e.studentId)!;
    db.reportCards.push({ id: uid(), studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, className: basic2.name, termId: curTerm.id, status: 'draft', average: int(48, 92), position: e.rollNumber, teacherRemark: '', headRemark: '', conduct: 'Good', interest: pick(['Reading', 'Football', 'Drawing', 'Music']) });
  }

  // A withdrawal in progress.
  const leaver = db.students.find((s) => s.id !== kwame.id && s.id !== ama.id && db.enrolments.some((e) => e.studentId === s.id && e.classId !== basic2.id))!;
  db.withdrawals.push({
    id: uid(),
    student: summary(db, leaver),
    reason: 'Family relocating to Kumasi',
    kind: 'transfer_out',
    destinationSchool: 'Asokwa Model School, Kumasi',
    status: 'pending_clearance',
    balancePesewas: balanceOf(db, leaver.id),
    clearance: { fees: { cleared: false }, books: { cleared: true, by: 'Abdulai Iddrisu', at: '2026-11-12T10:00:00Z' }, uniform: { cleared: false }, property: { cleared: false }, library: { cleared: true, by: 'Abdulai Iddrisu', at: '2026-11-12T10:05:00Z' } },
    startedAt: '2026-11-12T09:30:00Z',
  });

  // An earlier import.
  db.imports.push({ id: uid(), type: 'students_guardians', fileName: 'kg1-admissions-2026.xlsx', status: 'committed', totals: { rows: 12, valid: 11, warnings: 1, errors: 0, duplicates: 0, committed: 12 }, createdAt: '2026-09-03T08:30:00Z', createdBy: 'Abdulai Iddrisu' });

  // A little audit history.
  db.audit.push(
    { id: uid(), at: '2026-11-16T07:45:00Z', actorName: 'Yaw Boateng', action: 'login', entityType: 'user', summary: 'Signed in (MFA)' },
    { id: uid(), at: '2026-11-16T16:10:00Z', actorName: 'Yaw Boateng', action: 'update', entityType: 'cash_up', summary: 'Closed cash-up for 16 Nov 2026 (no variance)' },
  );

  return db;
}

// ---------- shared domain helpers (used by seed and handlers) ----------
export function balanceOf(db: Db, studentId: string): number {
  return db.ledger.filter((l) => l.studentId === studentId).reduce((a, l) => a + l.amountPesewas, 0);
}

export function currentEnrolment(db: Db, studentId: string) {
  return db.enrolments.find((e) => e.studentId === studentId && !e.endDate) ?? null;
}

export function summary(db: Db, s: MStudent) {
  const en = currentEnrolment(db, s.id);
  const cls = en ? db.classes.find((c) => c.id === en.classId) : undefined;
  return {
    id: s.id,
    studentCode: s.studentCode,
    fullName: [s.firstName, s.middleNames, s.lastName].filter(Boolean).join(' '),
    preferredName: s.preferredName,
    className: cls?.name,
    rollNumber: en?.rollNumber,
    status: s.status,
    photoUrl: s.photoUrl,
    hasMedicalAlert: Boolean(s.medical?.alertSummary),
  };
}

export function applyPayment(
  db: Db,
  input: { studentId: string; amountPesewas: number; method: PaymentMethod; referenceNo?: string; receivedAt: string; recordedBy: string; recordedById: string; payerName?: string; payerGuardianId?: string; notes?: string; allocations?: { invoiceLineId: string; amountPesewas: number }[]; idempotencyKey?: string },
): MPayment {
  db.counters.receipt += 1;
  const receiptNo = `RCP-${String(db.counters.receipt).padStart(6, '0')}`;
  const lines = db.invoices
    .filter((i) => i.studentId === input.studentId && i.status === 'issued')
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate))
    .flatMap((i) => [...i.lines].sort((a, b) => a.priority - b.priority));
  const allocations: MPayment['allocations'] = [];
  let remaining = input.amountPesewas;
  if (input.allocations?.length) {
    for (const a of input.allocations) {
      const line = lines.find((l) => l.id === a.invoiceLineId);
      if (!line) continue;
      line.paidPesewas += a.amountPesewas;
      remaining -= a.amountPesewas;
      allocations.push({ invoiceLineId: line.id, feeItemName: line.feeItemName, amountPesewas: a.amountPesewas });
    }
  } else {
    for (const line of lines) {
      if (remaining <= 0) break;
      const due = line.amountPesewas - line.paidPesewas;
      if (due <= 0) continue;
      const take = Math.min(due, remaining);
      line.paidPesewas += take;
      remaining -= take;
      allocations.push({ invoiceLineId: line.id, feeItemName: line.feeItemName, amountPesewas: take });
    }
  }
  db.ledger.push({ id: uid(), studentId: input.studentId, postedAt: input.receivedAt, entryType: 'payment', description: `Payment — ${input.method.replace('_', ' ')}`, reference: receiptNo, amountPesewas: -input.amountPesewas });
  const p: MPayment = {
    id: uid(),
    receiptNo,
    studentId: input.studentId,
    amountPesewas: input.amountPesewas,
    method: input.method,
    referenceNo: input.referenceNo,
    status: 'confirmed',
    source: 'manual',
    receivedAt: input.receivedAt,
    recordedBy: input.recordedBy,
    recordedById: input.recordedById,
    payerName: input.payerName,
    payerGuardianId: input.payerGuardianId,
    notes: input.notes,
    allocations,
    creditCreatedPesewas: Math.max(0, remaining),
    balanceAfterPesewas: balanceOf(db, input.studentId),
    reversal: null,
    idempotencyKey: input.idempotencyKey,
  };
  db.payments.push(p);
  return p;
}

let instance: Db | null = null;
export function getDb(): Db {
  if (!instance) instance = createDb();
  return instance;
}
export function resetDb(seed?: number): Db {
  instance = createDb(seed);
  return instance;
}
