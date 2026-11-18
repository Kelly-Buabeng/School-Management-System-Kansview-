import { Alert, Button, Group, Select, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@/api/client';
import { classOptions, useClasses, useCurrentTerm, useSubjects } from '@/api/queries';
import type { ScoreSheet } from '@/api/types';
import { ProblemAlert } from '@/components/ProblemAlert';
import { PageHeader, QueryState } from '@/components/ui';

type Row = ScoreSheet['rows'][number];

/** Keyboard-friendly grid: Enter or ↓ moves down, ↑ moves up, Tab moves across. */
export default function ScoresPage() {
  const classes = useClasses();
  const subjects = useSubjects();
  const { terms, term } = useCurrentTerm();
  const [classId, setClassId] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const cid = classId ?? classes.data?.[0]?.id ?? null;
  const sid = subjectId ?? subjects.data?.[0]?.id ?? null;
  const tid = termId ?? term?.id ?? null;
  const query = useQuery({
    queryKey: ['scores', cid, tid, sid],
    queryFn: () => api.get<ScoreSheet>('/classes/{id}/scores', { path: { id: cid! }, query: { termId: tid, subjectId: sid } }),
    enabled: Boolean(cid && tid && sid),
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (query.data) setRows(query.data.rows);
    setDirty(false);
  }, [query.data]);
  const grid = useRef<HTMLTableElement>(null);
  const save = useMutation({
    mutationFn: () => api.put('/classes/{id}/scores', { path: { id: cid! }, query: { termId: tid, subjectId: sid }, body: { rows: rows.map(({ studentId, classScore, examScore }) => ({ studentId, classScore, examScore })) } }),
    onSuccess: () => {
      setDirty(false);
      notifications.show({ color: 'green', message: 'Scores saved.' });
    },
  });

  const setScore = (i: number, field: 'classScore' | 'examScore', raw: string) => {
    const n = raw === '' ? null : Number(raw);
    setDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [field]: n !== null && Number.isFinite(n) ? n : null } : r)));
  };
  const move = (e: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    const dir = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    grid.current?.querySelector<HTMLInputElement>(`input[data-cell="${row + dir}-${col}"]`)?.focus();
  };

  return (
    <>
      <PageHeader title="Score entry" subtitle="Class score out of 30, exam out of 70. Press Enter to go to the next child." />
      <Group mb="md" align="flex-end" wrap="wrap">
        <Select label="Class" data={classOptions(classes.data)} value={cid} onChange={setClassId} allowDeselect={false} />
        <Select label="Subject" data={(subjects.data ?? []).map((s) => ({ value: s.id, label: s.name }))} value={sid} onChange={setSubjectId} allowDeselect={false} />
        <Select label="Term" data={terms.map((t) => ({ value: t.id, label: t.name }))} value={tid} onChange={setTermId} allowDeselect={false} />
      </Group>
      <QueryState query={query} label="Loading scores…">
        {(sheet) => (
          <>
            {sheet.locked && <Alert color="gray" mb="sm">Scores for this term are locked. Ask the headteacher if a change is needed.</Alert>}
            <div className="table-scroll">
              <Table ref={grid} miw={480} maw={720} verticalSpacing={2}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>No.</Table.Th>
                    <Table.Th>Student</Table.Th>
                    <Table.Th>Class (/{sheet.classMax})</Table.Th>
                    <Table.Th>Exam (/{sheet.examMax})</Table.Th>
                    <Table.Th>Total</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((r, i) => {
                    const bad = (r.classScore ?? 0) > sheet.classMax || (r.examScore ?? 0) > sheet.examMax || (r.classScore ?? 0) < 0 || (r.examScore ?? 0) < 0;
                    return (
                      <Table.Tr key={r.studentId} bg={bad ? 'red.0' : undefined}>
                        <Table.Td>{r.rollNumber}</Table.Td>
                        <Table.Td>{r.fullName}</Table.Td>
                        {(['classScore', 'examScore'] as const).map((f, col) => (
                          <Table.Td key={f}>
                            <input
                              data-cell={`${i}-${col}`}
                              type="number"
                              inputMode="decimal"
                              min={0}
                              max={f === 'classScore' ? sheet.classMax : sheet.examMax}
                              step="0.5"
                              value={r[f] ?? ''}
                              disabled={sheet.locked}
                              onChange={(e) => setScore(i, f, e.currentTarget.value)}
                              onKeyDown={(e) => move(e, i, col)}
                              aria-label={`${f === 'classScore' ? 'Class score' : 'Exam score'} for ${r.fullName}`}
                              style={{ width: 72, padding: '6px 8px', fontSize: 16, border: '1px solid #868e96', borderRadius: 4 }}
                            />
                          </Table.Td>
                        ))}
                        <Table.Td fw={600}>{r.classScore === null && r.examScore === null ? '' : (r.classScore ?? 0) + (r.examScore ?? 0)}</Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </div>
            <ProblemAlert error={save.error} />
            {!sheet.locked && (
              <Group mt="md">
                <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
                  Save scores
                </Button>
                {dirty && <Text size="sm" c="orange.9">Unsaved changes</Text>}
              </Group>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}
