// Owner: Agent B. Upcoming birthdays (pure). Feb 29 birthdays are celebrated on Feb 28 in non-leap years.

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Next birthday on/after `today` (both YYYY-MM-DD). */
export function nextBirthday(dateOfBirth: string, today: string): string {
  const [, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const ty = Number(today.slice(0, 4));
  const onYear = (y: number) => {
    const day = m === 2 && d === 29 && !isLeap(y) ? 28 : d;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  const thisYear = onYear(ty);
  return thisYear >= today ? thisYear : onYear(ty + 1);
}

export interface BirthdayRow {
  id: string;
  name: string;
  dateOfBirth: string;
  className: string | null;
}

/** Birthdays from today up to and including today + `days` - 1 (14 days = today and the next 13 days). */
export function upcomingBirthdays<T extends BirthdayRow>(rows: T[], today: string, days = 14): Array<T & { birthday: string; turning: number; inDays: number }> {
  return rows
    .map((r) => {
      const b = nextBirthday(r.dateOfBirth, today);
      return { ...r, birthday: b, inDays: daysBetween(today, b), turning: Number(b.slice(0, 4)) - Number(r.dateOfBirth.slice(0, 4)) };
    })
    .filter((r) => r.inDays >= 0 && r.inDays < days)
    .sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}
