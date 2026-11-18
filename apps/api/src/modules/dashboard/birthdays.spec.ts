import { describe, expect, it } from 'vitest';
import { nextBirthday, upcomingBirthdays } from './birthdays';

describe('birthdays', () => {
  it('finds the next birthday, wrapping the year', () => {
    expect(nextBirthday('2015-11-20', '2026-11-17')).toBe('2026-11-20');
    expect(nextBirthday('2015-11-17', '2026-11-17')).toBe('2026-11-17');
    expect(nextBirthday('2015-01-03', '2026-12-25')).toBe('2027-01-03');
    expect(nextBirthday('2016-02-29', '2026-02-01')).toBe('2026-02-28');
    expect(nextBirthday('2016-02-29', '2027-12-01')).toBe('2028-02-29');
  });
  it('lists the next 14 days in order', () => {
    const rows = [
      { id: '1', name: 'Kwame', dateOfBirth: '2016-12-01', className: 'P4' },
      { id: '2', name: 'Akosua', dateOfBirth: '2017-11-17', className: 'P3' },
      { id: '3', name: 'Yaa', dateOfBirth: '2015-11-30', className: 'P5' },
      { id: '4', name: 'Kojo', dateOfBirth: '2015-11-16', className: 'P5' },
    ];
    const r = upcomingBirthdays(rows, '2026-11-17');
    expect(r.map((x) => [x.name, x.inDays, x.turning])).toEqual([['Akosua', 0, 9], ['Yaa', 13, 11]]);
  });
});
