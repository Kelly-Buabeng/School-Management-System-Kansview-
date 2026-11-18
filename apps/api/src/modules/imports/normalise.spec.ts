import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  cleanText, columnLooksMonthFirst, excelSerialToIso, normaliseName, parseAmount, parseClassLabel, parseDate, parseDateDetailed,
  parseEmail, parseGender, parsePhone, parseRelationship, parseTermLabel, parseYesNo, splitFullName,
} from './normalise';
import { normaliseHeader, headerLookup } from './import-columns';

const Y = { currentYear: 2026 };

describe('cleanText', () => {
  it('trims, collapses spaces and drops placeholders', () => {
    expect(cleanText('  Ama    Serwaa ')).toBe('Ama Serwaa');
    expect(cleanText('​Kofi')).toBe('Kofi');
    expect(cleanText('')).toBeNull();
    expect(cleanText('   ')).toBeNull();
    expect(cleanText('-')).toBeNull();
    expect(cleanText('N/A')).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(42)).toBe('42');
  });
});

describe('normaliseName', () => {
  it.each([
    ['KWAME', 'Kwame'],
    ['kwame', 'Kwame'],
    ['  ama   owusu-ansah ', 'Ama Owusu-Ansah'],
    ["o'neil", "O'Neil"],
    ['DeGraft', 'DeGraft'],
    ['ÉDÉM', 'Édém'],
  ])('%s → %s', (input, out) => expect(normaliseName(input)).toBe(out));
  it('returns null for empty', () => expect(normaliseName('  ')).toBeNull());
});

describe('parseDateDetailed', () => {
  it.each([
    ['12/03/2015', '2015-03-12'],
    ['12-03-2015', '2015-03-12'],
    ['12.03.2015', '2015-03-12'],
    ['1-3-15', '2015-03-01'],
    ['5/9/99', '1999-09-05'],
    ['12 March 2015', '2015-03-12'],
    ['12th March, 2015', '2015-03-12'],
    ['12 Mar 2015', '2015-03-12'],
    ['12-Mar-15', '2015-03-12'],
    ['March 12, 2015', '2015-03-12'],
    ['Sept 1 2020', '2020-09-01'],
    ['2015-03-12', '2015-03-12'],
    ['2015/3/12', '2015-03-12'],
    ['42075', '2015-03-12'],
  ])('%s → %s', (input, out) => {
    const r = parseDateDetailed(input, Y);
    expect(r && !('error' in r) && r.value).toBe(out);
  });

  it('reads Excel serial numbers', () => {
    expect(parseDateDetailed(42075, Y)).toMatchObject({ value: '2015-03-12' });
    expect(excelSerialToIso(36526)).toBe('2000-01-01');
    expect(excelSerialToIso(0)).toBeNull();
    expect(excelSerialToIso(Number.NaN)).toBeNull();
  });

  it('flags day/month ambiguity but keeps Ghana order', () => {
    expect(parseDateDetailed('05/03/2015', Y)).toEqual({ value: '2015-03-05', ambiguous: true, swapped: false });
    expect(parseDateDetailed('25/03/2015', Y)).toEqual({ value: '2015-03-25', ambiguous: false, swapped: false });
    expect(parseDateDetailed('03/03/2015', Y)).toEqual({ value: '2015-03-03', ambiguous: false, swapped: false });
  });

  it('swaps month-first dates that cannot be day-first', () => {
    expect(parseDateDetailed('03/25/2015', Y)).toEqual({ value: '2015-03-25', ambiguous: false, swapped: true });
  });

  it('rejects impossible or unknown dates', () => {
    expect(parseDateDetailed('31/02/2015', Y)).toHaveProperty('error');
    expect(parseDateDetailed('2015-02-30', Y)).toHaveProperty('error');
    expect(parseDateDetailed('yesterday', Y)).toHaveProperty('error');
    expect(parseDateDetailed('32 March 2015', Y)).toHaveProperty('error');
    expect(parseDateDetailed('13/13/2015', Y)).toHaveProperty('error');
    expect(parseDateDetailed(-5, Y)).toHaveProperty('error');
  });

  it('empty cells are null', () => {
    expect(parseDateDetailed(null, Y)).toBeNull();
    expect(parseDateDetailed('  ', Y)).toBeNull();
  });

  it('2-digit years pivot on the current year', () => {
    expect(parseDateDetailed('1/1/26', Y)).toMatchObject({ value: '2026-01-01' });
    expect(parseDateDetailed('1/1/27', Y)).toMatchObject({ value: '1927-01-01' });
  });

  it('round-trips any real date written DD/MM/YYYY (property)', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1950-01-01'), max: new Date('2030-12-31'), noInvalidDate: true }), (d) => {
        const isoStr = d.toISOString().slice(0, 10);
        const [y, m, day] = isoStr.split('-');
        const r = parseDateDetailed(`${day}/${m}/${y}`, Y);
        return !!r && !('error' in r) && r.value === isoStr;
      }),
    );
  });
});

describe('parseDate warnings', () => {
  it('warns on swapped month/day', () => {
    const r = parseDate('03/25/2015', 'Date of Birth', Y);
    expect(r).toMatchObject({ ok: true, value: '2015-03-25' });
    expect(r.ok && r.warning).toContain('25 March 2015');
  });
  it('warns on ambiguous only when the column looks month-first', () => {
    expect(parseDate('05/03/2015', 'DOB', Y)).toEqual({ ok: true, value: '2015-03-05' });
    const r = parseDate('05/03/2015', 'DOB', { ...Y, columnLooksMonthFirst: true });
    expect(r.ok && r.warning).toContain('5 March 2015');
  });
  it('errors carry the column label', () => {
    expect(parseDate('soon', 'Date of Birth', Y)).toMatchObject({ ok: false, error: expect.stringContaining('Date of Birth') });
  });
  it('column detection', () => {
    expect(columnLooksMonthFirst(['05/03/2015', '03/25/2015'], 2026)).toBe(true);
    expect(columnLooksMonthFirst(['05/03/2015', '25/03/2015', null], 2026)).toBe(false);
  });
});

describe('parseGender', () => {
  it.each([['M', 'male'], ['male', 'male'], ['Boy', 'male'], ['F', 'female'], ['GIRL', 'female'], ['f.', 'female']])('%s', (i, o) => {
    expect(parseGender(i)).toEqual({ ok: true, value: o });
  });
  it('rejects unknown and passes empty', () => {
    expect(parseGender('x')).toMatchObject({ ok: false });
    expect(parseGender('')).toEqual({ ok: true, value: null });
  });
});

describe('parseYesNo', () => {
  it('understands common answers', () => {
    expect(parseYesNo('Yes')).toEqual({ ok: true, value: true });
    expect(parseYesNo('y')).toEqual({ ok: true, value: true });
    expect(parseYesNo(true)).toEqual({ ok: true, value: true });
    expect(parseYesNo('No')).toEqual({ ok: true, value: false });
    expect(parseYesNo('')).toEqual({ ok: true, value: null });
    expect(parseYesNo('maybe')).toMatchObject({ ok: false });
  });
});

describe('parseRelationship', () => {
  it('maps synonyms', () => {
    expect(parseRelationship('Mum')).toEqual({ ok: true, value: 'mother' });
    expect(parseRelationship('Daddy')).toEqual({ ok: true, value: 'father' });
    expect(parseRelationship('Grand Mother')).toEqual({ ok: true, value: 'grandparent' });
    expect(parseRelationship('Auntie')).toEqual({ ok: true, value: 'aunt' });
    expect(parseRelationship('Elder Sister')).toEqual({ ok: true, value: 'sibling' });
  });
  it('unknown becomes other with a warning', () => {
    expect(parseRelationship('Pastor')).toMatchObject({ ok: true, value: 'other', warning: expect.any(String) });
  });
});

describe('parsePhone', () => {
  it.each([
    ['0244000101', '+233244000101'],
    ['024 400 0101', '+233244000101'],
    ['+233 24 400 0101', '+233244000101'],
    ['233244000101', '+233244000101'],
    ['244000101', '+233244000101'],
    ['(024) 400-0101', '+233244000101'],
  ])('%s', (i, o) => expect(parsePhone(i, 'Phone')).toEqual({ ok: true, value: { primary: o, extra: null } }));
  it('numeric cell that lost its leading zero', () => {
    expect(parsePhone(244000101, 'Phone')).toEqual({ ok: true, value: { primary: '+233244000101', extra: null } });
  });
  it('two numbers in one cell', () => {
    expect(parsePhone('0244000101 / 0200000102', 'Phone')).toEqual({ ok: true, value: { primary: '+233244000101', extra: '+233200000102' } });
    expect(parsePhone('0244000101 or 0200000102', 'Phone')).toMatchObject({ ok: true, value: { extra: '+233200000102' } });
  });
  it('invalid numbers are errors', () => {
    expect(parsePhone('12345', 'Guardian 1 Phone')).toMatchObject({ ok: false, error: expect.stringContaining('Guardian 1 Phone') });
    expect(parsePhone('0844000101', 'Phone')).toMatchObject({ ok: false });
  });
  it('empty is fine', () => expect(parsePhone('', 'Phone')).toEqual({ ok: true, value: { primary: null, extra: null } }));
});

describe('parseEmail', () => {
  it('lower-cases and drops invalid with a warning', () => {
    expect(parseEmail('Ama@Example.COM', 'Email')).toEqual({ ok: true, value: 'ama@example.com' });
    expect(parseEmail('not an email', 'Email')).toMatchObject({ ok: true, value: null, warning: expect.any(String) });
  });
});

describe('parseAmount', () => {
  it.each([
    ['1,250.00', 125000],
    ['1250.5', 125050],
    ['GH₵ 20', 2000],
    ['GH¢ 1,000', 100000],
    ['GHS 15.75', 1575],
    ['-150.00', -15000],
    ['(150.00)', -15000],
    ['0', 0],
  ])('%s → %i pesewas', (i, o) => expect(parseAmount(i, 'Amount')).toEqual({ ok: true, value: o }));
  it('numeric cells', () => {
    expect(parseAmount(480.5, 'Amount')).toEqual({ ok: true, value: 48050 });
    expect(parseAmount(1200, 'Amount')).toEqual({ ok: true, value: 120000 });
  });
  it('rejects junk and too many decimals', () => {
    expect(parseAmount('abc', 'Amount')).toMatchObject({ ok: false });
    expect(parseAmount('1.234', 'Amount')).toMatchObject({ ok: false });
    expect(parseAmount(1e21, 'Amount')).toMatchObject({ ok: false });
  });
  it('never uses floats: integer pesewas for any 2-dp amount (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (p) => {
        const s = `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;
        const r = parseAmount(s, 'A');
        return r.ok && r.value === p;
      }),
    );
  });
});

describe('parseClassLabel', () => {
  it.each([
    ['P3 A', 'P3', 'A'],
    ['p3a', 'P3', 'A'],
    ['Primary 3 A', 'P3', 'A'],
    ['Basic 3A', 'P3', 'A'],
    ['Class 3 - B', 'P3', 'B'],
    ['JHS 1B', 'JHS1', 'B'],
    ['JSS2', 'JHS2', null],
    ['B7', 'JHS1', null],
    ['Basic 9 A', 'JHS3', 'A'],
    ['KG 2', 'KG2', null],
    ['KG1 B', 'KG1', 'B'],
    ['Nursery', 'NURSERY', null],
    ['Creche', 'CRECHE', null],
  ])('%s', (input, level, stream) => expect(parseClassLabel(input)).toEqual({ levelCode: level, stream }));
  it('unknown', () => {
    expect(parseClassLabel('Form 9')).toBeNull();
    expect(parseClassLabel('Year 12')).toBeNull();
    expect(parseClassLabel('')).toBeNull();
  });
});

describe('parseTermLabel', () => {
  it.each([
    ['2026/2027 Term 1', '2026/2027', 1],
    ['Term 2 2026/2027', '2026/2027', 2],
    ['T3 2026/27', '2026/2027', 3],
    ['First Term 2026-2027', '2026/2027', 1],
    ['2nd term 2025/2026', '2025/2026', 2],
  ])('%s', (i, y, n) => expect(parseTermLabel(i)).toEqual({ yearName: y, number: n }));
  it('unknown', () => expect(parseTermLabel('Term 1')).toBeNull());
});

describe('splitFullName', () => {
  it('surname first with comma', () => {
    expect(splitFullName('MENSAH, Kwame Kofi')).toEqual({ firstName: 'Kwame', middleNames: 'Kofi', lastName: 'Mensah', guessed: false });
  });
  it('guesses first/last otherwise', () => {
    expect(splitFullName('ama serwaa owusu')).toEqual({ firstName: 'Ama', middleNames: 'Serwaa', lastName: 'Owusu', guessed: true });
    expect(splitFullName('Ama')).toBeNull();
  });
});

describe('header matching', () => {
  it('normalises headers', () => {
    expect(normaliseHeader('Date of Birth')).toBe('dateofbirth');
    expect(normaliseHeader('D.O.B')).toBe('dob');
    expect(normaliseHeader(' DOB ')).toBe('dob');
    expect(normaliseHeader('First Name *')).toBe('firstname');
    expect(normaliseHeader('Date of Birth (DD/MM/YYYY)')).toBe('dateofbirth');
  });
  it('maps synonyms to keys', () => {
    const l = headerLookup('students_guardians');
    for (const h of ['Date of Birth', 'DOB', 'D.O.B', 'birth date']) expect(l.get(normaliseHeader(h))).toBe('dateOfBirth');
    expect(l.get(normaliseHeader('SURNAME'))).toBe('lastName');
    expect(l.get(normaliseHeader('Sex'))).toBe('gender');
    expect(l.get(normaliseHeader('Parent Phone'))).toBe('g1Phone');
    expect(l.get(normaliseHeader("Guardian 2 Mobile"))).toBe('g2Phone');
    expect(l.get(normaliseHeader('Admission No.'))).toBe('legacyId');
  });
});
