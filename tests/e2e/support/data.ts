// Owner: Agent H. Small helpers for finding seeded records and making unique fake data.
import type { ApiSession } from './api';

export const list = <T = any>(body: unknown): T[] => (Array.isArray(body) ? body : ((body as { data?: T[] }).data ?? [])) as T[];

let phoneSeq = Math.floor(Date.now() / 1000) % 10_000;
/** Fake Ghanaian test number in the reserved +23320000xxxx range (never a real subscriber). */
export const fakePhone = (): string => `+23320000${String(phoneSeq++ % 10_000).padStart(4, '0')}`;
export const uniq = (): string => Math.random().toString(36).slice(2, 7);

export interface YearRow { id: string; name: string; status: string; startDate: string; endDate: string; terms: TermRow[] }

export async function currentYear(s: ApiSession): Promise<YearRow> {
  const years = list<YearRow>(await s.json(s.get('/academic-years')));
  const y = years.find((x) => x.status === 'current');
  if (!y) throw new Error('no current academic year in seed');
  return y;
}

export interface ClassRow { id: string; displayName: string; levelId: string; levelCode: string; stream: string | null; enrolledCount: number }

export async function classes(s: ApiSession, academicYearId?: string): Promise<ClassRow[]> {
  const yearId = academicYearId ?? (await currentYear(s)).id;
  return list<ClassRow>(await s.json(s.get('/classes', { academicYearId: yearId })));
}

export async function classByName(s: ApiSession, name: string, academicYearId?: string): Promise<ClassRow> {
  const all = await classes(s, academicYearId);
  const c = all.find((x) => x.displayName === name);
  if (!c) throw new Error(`class ${name} not found (have: ${all.map((x) => x.displayName).join(', ')})`);
  return c;
}

export interface TermRow { id: string; number: number; status: string; startDate: string; endDate: string }

export async function currentTerm(s: ApiSession): Promise<TermRow> {
  const t = (await currentYear(s)).terms.find((x) => x.status === 'current');
  if (!t) throw new Error('no current term in seed');
  return t;
}
