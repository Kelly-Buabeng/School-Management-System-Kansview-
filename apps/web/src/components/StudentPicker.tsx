import { Loader, Select } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/api/client';
import type { Page, Student, StudentSummary } from '@/api/types';

/** Type a name or student ID, pick the student. */
export function StudentPicker({
  value,
  onChange,
  label = 'Student',
  error,
  required,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null, student?: StudentSummary) => void;
  label?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), 300);
  const list = useQuery({
    queryKey: ['student-picker', debounced],
    queryFn: ({ signal }) => api.get<Page<StudentSummary>>('/students', { query: { q: debounced, pageSize: 10, status: 'active' }, signal }),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
  });
  // Keep the chosen student visible even when it is not in the current search results.
  const chosen = useQuery({ queryKey: ['student', value], queryFn: () => api.get<Student>('/students/{id}', { path: { id: value! } }), enabled: Boolean(value) });
  const items = [...(list.data?.data ?? [])];
  if (chosen.data && !items.some((s) => s.id === chosen.data.id)) items.unshift(chosen.data);
  return (
    <Select
      label={label}
      withAsterisk={required}
      searchable
      clearable
      disabled={disabled}
      placeholder="Type a name or student ID"
      nothingFoundMessage={debounced.length < 2 ? 'Type at least 2 letters' : list.isFetching ? 'Searching…' : 'No student found'}
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      data={items.map((s) => ({ value: s.id!, label: `${s.fullName} · ${s.studentCode} · ${s.className ?? ''}` }))}
      value={value}
      onChange={(id) => onChange(id, items.find((s) => s.id === id))}
      error={error}
      rightSection={list.isFetching ? <Loader size="xs" /> : undefined}
    />
  );
}
