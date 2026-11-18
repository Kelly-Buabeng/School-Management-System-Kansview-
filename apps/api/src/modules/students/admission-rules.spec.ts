import { describe, expect, it } from 'vitest';
import { alphabeticalRoll, isPossibleDuplicate, nextRollNumber, normaliseContacts, normaliseGuardianFlags } from './admission-rules';

describe('admission rules', () => {
  it('makes the first guardian primary and fee payer by default', () => {
    const r = normaliseGuardianFlags([{ id: 'a' }, { id: 'b' }]);
    expect(r.map((x) => [x.isPrimary, x.isFeePayer, x.canPickUp, x.receivesSms])).toEqual([[true, true, true, true], [false, false, true, true]]);
  });
  it('keeps explicit flags and rejects two primaries', () => {
    const r = normaliseGuardianFlags([{ isPrimary: false, isFeePayer: true }, { isPrimary: true, canPickUp: false }]);
    expect(r.map((x) => [x.isPrimary, x.isFeePayer, x.canPickUp])).toEqual([[false, true, true], [true, false, false]]);
    expect(() => normaliseGuardianFlags([{ isPrimary: true }, { isPrimary: true }])).toThrow(/one guardian/);
  });
  it('orders and renumbers contacts', () => {
    const r = normaliseContacts([
      { priority: 5, name: 'Auntie Efua', phone: '+233240000111' },
      { guardianId: 'g1' },
      { priority: 2, guardianId: 'g2' },
    ]);
    expect(r.map((x) => [x.priority, x.guardianId ?? x.name])).toEqual([[1, 'g2'], [2, 'Auntie Efua'], [3, 'g1']]);
    expect(() => normaliseContacts([{ priority: 1, guardianId: 'a' }, { priority: 1, guardianId: 'b' }])).toThrow(/same order/);
    expect(() => normaliseContacts([{ name: 'No phone' }])).toThrow(/name and phone/);
  });
  it('applies the duplicate rule (all three conditions)', () => {
    expect(isPossibleDuplicate({ similarity: 0.7, sameDob: true, sharedPhones: ['+233240000001'] })).toBe(true);
    expect(isPossibleDuplicate({ similarity: 0.59, sameDob: true, sharedPhones: ['+233240000001'] })).toBe(false);
    expect(isPossibleDuplicate({ similarity: 0.9, sameDob: false, sharedPhones: ['+233240000001'] })).toBe(false);
    expect(isPossibleDuplicate({ similarity: 0.9, sameDob: true, sharedPhones: [] })).toBe(false);
  });
  it('numbers rolls', () => {
    expect(nextRollNumber([])).toBe(1);
    expect(nextRollNumber([1, 2, 7])).toBe(8);
    const r = alphabeticalRoll([
      { lastName: 'Owusu', firstName: 'Ama', studentCode: 'b' },
      { lastName: 'asante', firstName: 'Kofi', studentCode: 'a' },
      { lastName: 'Asante', firstName: 'Abena', studentCode: 'c' },
    ]);
    expect(r.map((x) => [x.firstName, x.rollNumber])).toEqual([['Abena', 1], ['Kofi', 2], ['Ama', 3]]);
  });
});
