import { describe, expect, it } from 'vitest';
import { decodeText, detectDelimiter, parseCsv, readImportFile } from './file-reader';
import { validateRows, missingRequiredColumns, type ValidationContext, type NormalisedStudent } from './row-validation';
import { BALANCE_HEADERS, STAFF_HEADERS, STUDENT_HEADERS, csvFrom, generateStudentRows, messyStudentsWorkbook, FIXTURE_CLASSES } from '../../../test/g/fixtures';

const CTX: ValidationContext = {
  today: '2026-11-17',
  academicYearStart: '2026-09-08',
  classes: FIXTURE_CLASSES.map((d, i) => {
    const [level, stream] = d.split(' ');
    return { id: `c${i}`, levelCode: level!, stream: stream ?? null, displayName: d, capacity: 60, activeCount: 0 };
  }),
  terms: [{ id: 't1', yearName: '2026/2027', number: 1 }],
};

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, newlines in quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z', ',')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
  });
  it('detects delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('"a;x",b,c')).toBe(',');
  });
  it('decodes BOM and Windows-1252', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
  });
});

describe('readImportFile', () => {
  it('reads a semicolon CSV with BOM, blank rows and CRLF', async () => {
    const rows = [STUDENT_HEADERS, ...generateStudentRows(3), STUDENT_HEADERS.map(() => ''), ...generateStudentRows(5).slice(3)];
    const parsed = await readImportFile(csvFrom(rows, { delimiter: ';', bom: true, crlf: true }), 'students_guardians');
    expect(parsed.format).toBe('csv');
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[3]!.rowNumber).toBe(6); // blank line 5 skipped but numbering kept
    expect(parsed.mapping['Old Student ID']).toBe('legacyId');
    expect(Object.keys(parsed.rows[0]!.cells)[0]).toBe('Old Student ID'); // BOM stripped
  });

  it('reads the messy workbook: title row, merged group headers, synonyms, Instructions sheet skipped', async () => {
    const parsed = await readImportFile(await messyStudentsWorkbook(), 'students_guardians', 'pupils.xlsx');
    expect(parsed.format).toBe('xlsx');
    expect(parsed.sheetName).toBe('Students');
    expect(parsed.headerRowNumber).toBe(3);
    expect(parsed.mapping).toMatchObject({ 'Admission No': 'legacyId', SURNAME: 'lastName', 'D.O.B': 'dateOfBirth', Sex: 'gender', 'Guardian 1 Name': 'g1FullName', 'Guardian 1 Phone': 'g1Phone', 'Guardian 2 Phone': 'g2Phone', 'Guardian 2 Relationship': 'g2Relationship' });
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([4, 6, 7, 8, 9, 10, 11, 12]);
    expect(missingRequiredColumns('students_guardians', parsed.mapping)).toEqual([]);

    const out = validateRows('students_guardians', parsed.rows, parsed.mapping, CTX);
    const byRow = new Map(out.map((o) => [o.rowNumber, o]));
    const s4 = byRow.get(4)!.normalised as NormalisedStudent;
    expect(s4).toMatchObject({ firstName: 'Kwame', lastName: 'Mensah', dateOfBirth: '2018-03-12', gender: 'male', classId: 'c4' });
    expect(s4.guardians[0]).toMatchObject({ firstName: 'Akosua', lastName: 'Mensah', relationship: 'mother', phonePrimary: '+233244000001', isFeePayer: true });
    expect(s4.guardians[1]).toMatchObject({ relationship: 'father', phonePrimary: '+233200000001' });
    expect((byRow.get(6)!.normalised as NormalisedStudent).classId).toBe('c9'); // p4b
    expect(byRow.get(7)!.messages).toContainEqual(expect.objectContaining({ severity: 'error', code: 'INVALID_DATE' })); // 31/02
    expect((byRow.get(8)!.normalised as NormalisedStudent).dateOfBirth).toBe('2014-09-09'); // real Excel date cell
    expect((byRow.get(8)!.normalised as NormalisedStudent).guardians[0]!.phonePrimary).toBe('+233244000004'); // lost leading zero
    expect(byRow.get(9)!.messages).toContainEqual(expect.objectContaining({ severity: 'error', code: 'DUPLICATE_IN_FILE' })); // same child as row 4
    const r10 = byRow.get(10)!.messages.map((m) => m.code);
    expect(r10).toContain('CLASS_NOT_FOUND');
    expect(r10).toContain('INVALID_PHONE');
    expect(byRow.get(11)!.messages).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_PHONE' })); // both guardians same number
    expect(byRow.get(12)!.messages).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'GUARDIAN_PHONE_SHARED' })); // different name, Mensah phone
  });

  it('rejects files without headings, empty files and old .xls', async () => {
    await expect(readImportFile(Buffer.from('hello\nworld'), 'students_guardians')).rejects.toMatchObject({ code: 'IMPORT_FILE_UNREADABLE' });
    await expect(readImportFile(Buffer.alloc(0), 'staff')).rejects.toMatchObject({ code: 'IMPORT_FILE_UNREADABLE' });
    await expect(readImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'staff', 'x.xls')).rejects.toMatchObject({ status: 400 });
    await expect(readImportFile(csvFrom([STUDENT_HEADERS]), 'students_guardians')).rejects.toMatchObject({ title: expect.stringContaining('no data rows') });
  });

  it('rejects more than 2,000 rows', async () => {
    await expect(readImportFile(csvFrom([STUDENT_HEADERS, ...generateStudentRows(2001)]), 'students_guardians')).rejects.toMatchObject({ title: expect.stringContaining('2000') });
  });
});

describe('row validation', () => {
  it('1,000 generated students validate without errors, siblings share guardians', async () => {
    const parsed = await readImportFile(csvFrom([STUDENT_HEADERS, ...generateStudentRows(1000)]), 'students_guardians');
    const out = validateRows('students_guardians', parsed.rows, parsed.mapping, CTX);
    const errors = out.flatMap((o) => o.messages.filter((m) => m.severity === 'error').map((m) => `${o.rowNumber}: ${m.message}`));
    expect(errors).toEqual([]);
    const phones = new Set(out.flatMap((o) => [(o.normalised as NormalisedStudent).guardians[0]!.phonePrimary]));
    expect(phones.size).toBeLessThan(1000);
  });

  it('flags unusual ages, future dates, missing guardian and month-first columns', async () => {
    const rows = [
      STUDENT_HEADERS,
      ['', 'Kofi', '', 'Ansah', '01/02/2005', 'M', 'P1 A', '', 'Ama', 'Ansah', 'Mother', '0244000900', '', '', '', '', ''],
      ['', 'Esi', '', 'Ansah', '01/02/2030', 'F', 'P1 A', '', 'Ama', 'Ansah', 'Mother', '0244000900', '', '', '', '', ''],
      ['', 'Yaw', '', 'Badu', '03/25/2019', 'M', 'P1 A', '', '', '', '', '', '', '', '', '', ''],
      ['', 'Afua', '', 'Badu', '05/03/2020', 'F', 'KG2', '', 'Akua', 'Badu', '', '0244000901', '', '', '', '', ''],
      ['', 'Kojo', '', 'Badu', '05/03/2020', 'M', 'P1', '', 'Akua', 'Badu', 'Mum', '0244000901', '', '', '', '', ''],
    ];
    const parsed = await readImportFile(csvFrom(rows), 'students_guardians');
    const out = validateRows('students_guardians', parsed.rows, parsed.mapping, CTX);
    expect(out[0]!.messages).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'AGE_UNUSUAL' }));
    expect(out[1]!.messages).toContainEqual(expect.objectContaining({ severity: 'error', message: 'Date of Birth is in the future.' }));
    expect(out[2]!.messages).toContainEqual(expect.objectContaining({ severity: 'error', field: 'g1FirstName' }));
    expect(out[2]!.messages.some((m) => m.severity === 'warning' && m.message.includes('month/day'))).toBe(true);
    expect(out[3]!.messages).toContainEqual(expect.objectContaining({ code: 'DEFAULTED', field: 'g1Relationship' }));
    expect(out[3]!.messages.some((m) => m.message.includes('Other dates in this column'))).toBe(true);
    expect(out[4]!.messages).toContainEqual(expect.objectContaining({ code: 'CLASS_NOT_FOUND', message: expect.stringContaining('which stream') }));
  });

  it('warns when a class goes over capacity', async () => {
    const ctx = { ...CTX, classes: CTX.classes.map((c) => ({ ...c, capacity: 1, activeCount: 1 })) };
    const parsed = await readImportFile(csvFrom([STUDENT_HEADERS, ...generateStudentRows(1)]), 'students_guardians');
    const out = validateRows('students_guardians', parsed.rows, parsed.mapping, ctx);
    expect(out[0]!.messages).toContainEqual(expect.objectContaining({ code: 'CLASS_OVER_CAPACITY', severity: 'error' }));
  });

  it('staff rows', async () => {
    const rows = [
      STAFF_HEADERS,
      ['ST-1', 'yaa', 'ASANTEWAA', 'F', '02/05/1988', '0244000501', 'yaa@example.com', 'Teaching', 'Teacher', '01/09/2015'],
      ['st-1', 'Kojo', 'Asante', 'M', '', '0244000501', '', 'support', '', ''],
      ['', 'Ama', 'Darko', 'F', '', '', '', 'cook', '', ''],
    ];
    const parsed = await readImportFile(csvFrom(rows), 'staff');
    const out = validateRows('staff', parsed.rows, parsed.mapping, CTX);
    expect(out[0]!.normalised).toMatchObject({ staffCode: 'ST-1', firstName: 'Yaa', lastName: 'Asantewaa', staffType: 'teaching', phone: '+233244000501' });
    expect(out[1]!.normalised).toMatchObject({ staffType: 'non_teaching' });
    expect(out[1]!.messages.map((m) => m.code)).toEqual(expect.arrayContaining(['DUPLICATE_IN_FILE', 'DUPLICATE_PHONE']));
    expect(out[2]!.messages.filter((m) => m.severity === 'error').map((m) => m.field)).toEqual(expect.arrayContaining(['phone', 'staffType']));
  });

  it('opening balance rows', async () => {
    const rows = [
      BALANCE_HEADERS,
      ['', 'OLD-1', 'Abena Owusu', '1,250.00', '2026/2027 Term 1', ''],
      ['KSV-26-00002-9', '', '', '(150)', 'Term 1 2026/27', ''],
      ['KSV-26-00002-8', '', '', '10', '2026/2027 Term 1', ''],
      ['', '', '', 'abc', '2025/2026 Term 3', ''],
      ['', 'OLD-1', '', '5', '2026/2027 Term 1', ''],
    ];
    const parsed = await readImportFile(csvFrom(rows), 'opening_balances');
    const out = validateRows('opening_balances', parsed.rows, parsed.mapping, CTX);
    expect(out[0]!.normalised).toMatchObject({ legacyId: 'OLD-1', amountPesewas: 125000, termId: 't1' });
    expect(out[1]!.normalised).toMatchObject({ studentCode: 'KSV-26-00002-9', amountPesewas: -15000 });
    expect(out[2]!.messages[0]!.message).toContain('typing mistake');
    expect(out[3]!.messages.map((m) => m.code)).toEqual(expect.arrayContaining(['REQUIRED', 'INVALID_AMOUNT', 'TERM_NOT_FOUND']));
    expect(out[4]!.messages).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_IN_FILE' }));
  });
});
