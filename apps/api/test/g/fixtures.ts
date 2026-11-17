/**
 * Messy import fixture files generated in code (Agent G). FAKE Ghanaian data only; phone numbers in the
 * +23320000xxxx / +23324000xxxx test ranges.
 */
import ExcelJS from 'exceljs';

const FIRST_GIRLS = ['Ama', 'Abena', 'Akosua', 'Adwoa', 'Afua', 'Yaa', 'Efua', 'Esi', 'Akua', 'Selorm', 'Dzifa', 'Mawuena', 'Fatima', 'Amina', 'Naa', 'Dede', 'Adjoa', 'Elinam'];
const FIRST_BOYS = ['Kwame', 'Kofi', 'Kwabena', 'Kwaku', 'Yaw', 'Kwasi', 'Kojo', 'Kobina', 'Edem', 'Senyo', 'Ibrahim', 'Abdul', 'Nii', 'Tetteh', 'Elikem', 'Fiifi', 'Kweku', 'Mohammed'];
const SURNAMES = ['Mensah', 'Owusu', 'Boateng', 'Asante', 'Agyeman', 'Osei', 'Ofori', 'Addo', 'Agbeko', 'Kpodo', 'Mahama', 'Iddrisu', 'Quaye', 'Lamptey', 'Tetteh', 'Ansah', 'Darko', 'Amoah', 'Badu', 'Frimpong', 'Nkrumah', 'Sarpong', 'Danso', 'Gyamfi', 'Wiredu'];

export const STUDENT_HEADERS = [
  'Old Student ID', 'First Name', 'Middle Names', 'Last Name', 'Date of Birth', 'Gender', 'Class', 'Medical Alert',
  'Guardian 1 First Name', 'Guardian 1 Last Name', 'Guardian 1 Relationship', 'Guardian 1 Phone', 'Guardian 1 Pays Fees',
  'Guardian 2 First Name', 'Guardian 2 Last Name', 'Guardian 2 Relationship', 'Guardian 2 Phone',
];

/** Class labels used by generated rows; tests create matching classes. */
export const FIXTURE_CLASSES = ['KG1', 'KG2', 'P1 A', 'P1 B', 'P2 A', 'P2 B', 'P3 A', 'P3 B', 'P4 A', 'P4 B', 'P5 A', 'P5 B', 'P6 A', 'P6 B', 'JHS1 A', 'JHS1 B', 'JHS2 A', 'JHS2 B', 'JHS3 A', 'JHS3 B'];
const TYPICAL_AGE: Record<string, number> = { KG1: 4, KG2: 5, P1: 6, P2: 7, P3: 8, P4: 9, P5: 10, P6: 11, JHS1: 12, JHS2: 13, JHS3: 14 };

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/**
 * `count` realistic students. Families of 1-3 children share guardian phones (siblings). Deterministic.
 * `academicYearStartYear`: children's birth years fit their class for that year.
 */
export function generateStudentRows(count: number, academicYearStartYear = 2026): string[][] {
  const rows: string[][] = [];
  let family = 0;
  let i = 0;
  while (rows.length < count) {
    family += 1;
    const kids = (family % 3) + 1;
    const surname = SURNAMES[family % SURNAMES.length]!;
    const motherPhone = `0244${pad(family, 6)}`;
    const fatherPhone = `0200${pad(family, 6)}`;
    for (let k = 0; k < kids && rows.length < count; k += 1) {
      i += 1;
      const girl = (i + k) % 2 === 0;
      const first = girl ? FIRST_GIRLS[i % FIRST_GIRLS.length]! : FIRST_BOYS[i % FIRST_BOYS.length]!;
      const middle = (girl ? FIRST_GIRLS : FIRST_BOYS)[(i * 7) % 18]!;
      const cls = FIXTURE_CLASSES[(i * 3 + k * 5) % FIXTURE_CLASSES.length]!;
      const level = cls.split(' ')[0]!;
      const age = TYPICAL_AGE[level]!;
      const birthYear = academicYearStartYear - age;
      const dob = `${pad((i % 28) + 1)}/${pad(((i * 5) % 12) + 1)}/${birthYear}`;
      rows.push([
        `OLD-${pad(i, 5)}`, first, middle, surname, dob, girl ? 'F' : 'M', cls, i % 50 === 0 ? 'Asthma, inhaler in bag' : '',
        FIRST_GIRLS[family % FIRST_GIRLS.length]!, surname, 'Mother', motherPhone, 'Yes',
        FIRST_BOYS[family % FIRST_BOYS.length]!, surname, 'Father', fatherPhone,
      ]);
    }
  }
  return rows;
}

export async function xlsxFrom(rows: Array<Array<string | number | Date | null>>, opts: { sheetName?: string; merges?: string[]; withInstructions?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  if (opts.withInstructions) wb.addWorksheet('Instructions').addRow(['Read me first']);
  const ws = wb.addWorksheet(opts.sheetName ?? 'Students');
  for (const r of rows) ws.addRow(r);
  for (const m of opts.merges ?? []) ws.mergeCells(m);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export function csvFrom(rows: string[][], opts: { delimiter?: string; bom?: boolean; crlf?: boolean } = {}): Buffer {
  const d = opts.delimiter ?? ',';
  const esc = (v: string) => (v.includes(d) || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v);
  const text = rows.map((r) => r.map(esc).join(d)).join(opts.crlf ? '\r\n' : '\n');
  return Buffer.concat([opts.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
}

/**
 * A deliberately messy students workbook:
 * - a merged title row and merged "Guardian 1" / "Guardian 2" group headers over short sub-headings,
 * - synonyms (SURNAME, D.O.B, Sex), blank rows, padded/upper-case names,
 * - mixed date styles, a wrong date, an Excel date cell, a duplicate child, and two families sharing a phone.
 */
export async function messyStudentsWorkbook(): Promise<Buffer> {
  const rows: Array<Array<string | number | Date | null>> = [
    ['KANSVIEW SCHOOL - PUPILS LIST 2026', null, null, null, null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, 'Guardian 1', null, null, null, 'Guardian 2', null, null],
    ['Admission No', 'FIRST NAME', 'SURNAME', 'D.O.B', 'Sex', 'Class', 'Name', 'Relationship', 'Phone', 'Pays Fees', 'Name', 'Relationship', 'Phone'],
    ['A001', '  KWAME ', 'mensah', '12/03/2018', 'M', 'P2 A', 'Akosua Mensah', 'Mum', '024 400 0001', 'yes', 'Kojo Mensah', 'Daddy', '0200000001'],
    [null, null, null, null, null, null, null, null, null, null, null, null, null],
    ['A002', 'Ama', 'Mensah', '5 June 2016', 'Girl', 'p4b', 'Akosua Mensah', 'Mother', '+233244000001', '', '', '', ''],
    ['A003', 'Yaw', 'Boateng', '31/02/2017', 'Boy', 'P3 A', 'Efua Boateng', 'Mother', '0244000003', 'Yes', '', '', ''],
    ['A004', 'Esi', 'Owusu', new Date(Date.UTC(2014, 8, 9)), 'F', 'P6 A', 'Kofi Owusu', 'Father', '244000004', 'Yes', '', '', ''],
    ['A005', 'Kwame', 'Mensah', '12-3-18', 'Male', 'P2 A', 'Akosua Mensah', 'Mother', '0244000001', 'Yes', '', '', ''],
    ['A006', 'Afua', 'Asante', '01/07/2015', 'F', 'Primary 9', 'Yaa Asante', 'Mother', '12345', 'Yes', '', '', ''],
    ['A007', 'Kojo', 'Addo', '14/11/2013', 'M', 'JHS1 A', 'Nana Addo', 'Grandmother', '0244000007', 'Yes', 'Adwoa Addo', 'Aunt', '0244000007'],
    ['A008', 'Abena', 'Darko', '20/04/2019', 'F', 'KG2', 'Akosua Darko', 'Mother', '0244000001', 'Yes', '', '', ''],
    [null, null, null, null, null, null, null, null, null, null, null, null, null],
  ];
  return xlsxFrom(rows, { merges: ['A1:M1', 'G2:J2', 'K2:M2'], withInstructions: true });
}

export const BALANCE_HEADERS = ['Student ID', 'Old Student ID', 'Student Name', 'Amount (GH₵)', 'As of Term', 'Note'];
export const STAFF_HEADERS = ['Staff ID', 'First Name', 'Last Name', 'Gender', 'Date of Birth', 'Phone', 'Email', 'Staff Type', 'Job Title', 'Employment Date'];
