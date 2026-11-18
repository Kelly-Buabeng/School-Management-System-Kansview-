import { Alert, Button, Card, Group, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '@/api/client';
import { classOptions, useClasses } from '@/api/queries';
import type { AttendanceMark, AttendanceRegister } from '@/api/types';
import { ProblemAlert } from '@/components/ProblemAlert';
import { PageHeader, QueryState } from '@/components/ui';
import { formatDate, todayInAccra } from '@/lib/format';

type Entry = AttendanceRegister['entries'][number];
const MARKS: { value: AttendanceMark; label: string }[] = [
  { value: 'present', label: 'Present' },
  { value: 'absent', label: 'Absent' },
  { value: 'late', label: 'Late' },
  { value: 'excused', label: 'Excused' },
];

export default function AttendancePage() {
  const [params, setParams] = useSearchParams();
  const classes = useClasses();
  const classId = params.get('classId') ?? classes.data?.[0]?.id ?? '';
  const date = params.get('date') ?? todayInAccra();
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set(k, v);
    setParams(n, { replace: true });
  };
  const query = useQuery({
    queryKey: ['attendance', classId, date],
    queryFn: () => api.get<AttendanceRegister>('/classes/{id}/attendance', { path: { id: classId }, query: { date } }),
    enabled: Boolean(classId),
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) setEntries(query.data.entries);
    setSavedAt(null);
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => api.put<{ absentSmsQueued?: number }>('/classes/{id}/attendance', { path: { id: classId }, query: { date }, body: { entries: entries.map(({ studentId, status, reason }) => ({ studentId, status, reason: reason || undefined })) } }),
    onSuccess: (r) => {
      setSavedAt(new Date().toISOString());
      notifications.show({ color: 'green', title: 'Register saved', message: r?.absentSmsQueued ? `${r.absentSmsQueued} absence SMS will be sent to parents.` : undefined });
    },
  });
  const update = (id: string, patch: Partial<Entry>) => {
    setSavedAt(null);
    setEntries((es) => es.map((e) => (e.studentId === id ? { ...e, ...patch } : e)));
  };
  const absent = entries.filter((e) => e.status === 'absent').length;

  return (
    <>
      <PageHeader title="Attendance register" subtitle="Everyone starts as present. Tap only the children who are not." />
      <Group mb="md" align="flex-end" wrap="wrap">
        <Select label="Class" data={classOptions(classes.data)} value={classId || null} onChange={(v) => v && set('classId', v)} allowDeselect={false} />
        <TextInput type="date" label="Date" value={date} max={todayInAccra()} onChange={(e) => set('date', e.currentTarget.value)} />
      </Group>
      <QueryState query={query} label="Loading register…">
        {(reg) => (
          <Stack maw={760}>
            {reg.taken && !savedAt && <Alert color="blue">This register was already taken for {formatDate(date)}. Saving again replaces it.</Alert>}
            <Group justify="space-between">
              <Text size="sm">
                {entries.length} children · <b>{absent} absent</b>
              </Text>
              <Button variant="light" size="xs" onClick={() => setEntries((es) => es.map((e) => ({ ...e, status: 'present', reason: undefined })))}>
                Mark all present
              </Button>
            </Group>
            {entries.map((e) => (
              <Card key={e.studentId} withBorder p="xs" bg={e.status === 'absent' ? 'red.0' : e.status === 'present' ? undefined : 'yellow.0'}>
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Text fw={600} size="sm" style={{ minWidth: 160 }}>
                    {e.rollNumber}. {e.fullName}
                  </Text>
                  <SegmentedControl size="sm" value={e.status} onChange={(v) => update(e.studentId, { status: v as AttendanceMark })} data={MARKS} aria-label={`Attendance for ${e.fullName}`} />
                </Group>
                {e.status !== 'present' && <TextInput mt={6} size="xs" placeholder="Reason (optional), e.g. sick, travelled" aria-label={`Reason for ${e.fullName}`} value={e.reason ?? ''} onChange={(ev) => update(e.studentId, { reason: ev.currentTarget.value })} />}
              </Card>
            ))}
            <ProblemAlert error={save.error} />
            <Group>
              <Button size="md" onClick={() => save.mutate()} loading={save.isPending} disabled={entries.length === 0}>
                Save register
              </Button>
              {savedAt && <Text c="green.8" fw={600}>Saved</Text>}
            </Group>
          </Stack>
        )}
      </QueryState>
    </>
  );
}
