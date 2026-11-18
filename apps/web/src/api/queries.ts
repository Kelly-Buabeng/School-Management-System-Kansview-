/** Shared look-up queries used by many screens. */
import { useQuery } from '@tanstack/react-query';
import { listOf, normClass, normYear } from '@/api/normalise';
import { api } from './client';
import type { AcademicYear, ClassInfo, Level, ListResponse, Subject, Term } from './types';

export function useAcademicYears() {
  return useQuery({
    queryKey: ['academic-years'],
    queryFn: () => api.get<unknown>('/academic-years').then((r) => listOf<Record<string, unknown>>(r).map(normYear)),
    staleTime: 5 * 60_000,
  });
}

export function useCurrentTerm(): { year?: AcademicYear; term?: Term; terms: Term[]; years: AcademicYear[] } {
  const { data } = useAcademicYears();
  const years = data ?? [];
  const year = years.find((y) => y.isCurrent);
  const terms = years.flatMap((y) => (y.terms ?? []).map((t) => ({ ...t, name: `${y.name} ${t.name}` })));
  const term = terms.find((t) => t.isCurrent) ?? terms.find((t) => t.academicYearId === year?.id);
  return { year, term, terms, years };
}

export function useClasses(academicYearId?: string) {
  return useQuery({
    queryKey: ['classes', academicYearId ?? 'current'],
    queryFn: () => api.get<unknown>('/classes', { query: { academicYearId } }).then((r) => listOf<Record<string, unknown>>(r).map(normClass)),
    staleTime: 60_000,
  });
}

export function useLevels() {
  return useQuery({ queryKey: ['levels'], queryFn: () => api.get<unknown>('/levels').then(listOf<Level>), staleTime: 5 * 60_000 });
}

export function useSubjects() {
  return useQuery({ queryKey: ['subjects'], queryFn: () => api.get<unknown>('/subjects').then(listOf<Subject>), staleTime: 5 * 60_000 });
}

export const classOptions = (classes: ClassInfo[] | undefined) => (classes ?? []).map((c) => ({ value: c.id, label: c.name }));
