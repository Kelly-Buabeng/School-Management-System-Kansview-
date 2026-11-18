import { Button, Checkbox, Group, Select, Table, Text, Textarea } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listOf } from '@/api/normalise';
import { api, downloadFile } from '@/api/client';
import { classOptions, useClasses, useCurrentTerm } from '@/api/queries';
import type { ListResponse, ReportCard } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError } from '@/components/ProblemAlert';
import { EmptyState, PageHeader, QueryState, StatusBadge } from '@/components/ui';

function RemarkCell({ rc, field, editable }: { rc: ReportCard; field: 'teacherRemark' | 'headRemark'; editable: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(rc[field] ?? '');
  const save = useMutation({
    mutationFn: () => api.patch('/report-cards/{id}', { path: { id: rc.id }, body: { [field]: value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['report-cards'] }),
    onError: (e) => notifications.show(notifyError(e)),
  });
  if (!editable) return <Text size="sm">{rc[field] || '—'}</Text>;
  return (
    <Textarea
      size="xs"
      autosize
      minRows={1}
      aria-label={`${field === 'teacherRemark' ? "Teacher's" : "Head's"} remark for ${rc.studentName}`}
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={() => value !== (rc[field] ?? '') && save.mutate()}
      rightSection={save.isPending ? '…' : undefined}
    />
  );
}

export default function ReportCardsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const classes = useClasses();
  const { terms, term } = useCurrentTerm();
  const [classId, setClassId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const cid = classId ?? classes.data?.find((c) => c.name === 'Basic 2')?.id ?? classes.data?.[0]?.id ?? null;
  const tid = termId ?? term?.id ?? null;
  const query = useQuery({ queryKey: ['report-cards', tid, cid], queryFn: () => api.get<unknown>('/report-cards', { query: { termId: tid, classId: cid } }).then(listOf<ReportCard>), enabled: Boolean(tid) });
  const publish = useMutation({
    mutationFn: () => api.post<{ published: number }>('/report-cards/publish', { body: { ids: selected } }),
    onSuccess: (r) => {
      notifications.show({ color: 'green', message: `${r.published} report card(s) published.` });
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['report-cards'] });
    },
    onError: (e) => notifications.show(notifyError(e)),
  });
  const editTeacher = can('academics:update');
  const editHead = can('academics:publish');
  return (
    <>
      <PageHeader
        title="Report cards"
        actions={
          <Can perm="academics:publish">
            <Button
              disabled={selected.length === 0}
              onClick={() =>
                modals.openConfirmModal({
                  title: `Publish ${selected.length} report card(s)?`,
                  children: <Text size="sm">Published report cards can be printed and given to parents. Remarks are then locked.</Text>,
                  labels: { confirm: 'Publish', cancel: 'Cancel' },
                  onConfirm: () => publish.mutate(),
                })
              }
            >
              Publish selected
            </Button>
          </Can>
        }
      />
      <Group mb="md" wrap="wrap">
        <Select label="Class" data={classOptions(classes.data)} value={cid} onChange={setClassId} allowDeselect={false} />
        <Select label="Term" data={terms.map((t) => ({ value: t.id, label: t.name }))} value={tid} onChange={setTermId} allowDeselect={false} />
      </Group>
      <QueryState query={query}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>No report cards yet for this class and term. They are created after scores are entered.</EmptyState>
          ) : (
            <div className="table-scroll">
              <Table miw={860} verticalSpacing={4}>
                <Table.Thead>
                  <Table.Tr>
                    {editHead && (
                      <Table.Th>
                        <Checkbox aria-label="Select all drafts" checked={selected.length > 0 && selected.length === list.filter((r) => r.status === 'draft').length} onChange={(e) => setSelected(e.currentTarget.checked ? list.filter((r) => r.status === 'draft').map((r) => r.id) : [])} />
                      </Table.Th>
                    )}
                    <Table.Th>Student</Table.Th>
                    <Table.Th>Average</Table.Th>
                    <Table.Th>Position</Table.Th>
                    <Table.Th>Teacher's remark</Table.Th>
                    <Table.Th>Head's remark</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.map((rc) => (
                    <Table.Tr key={rc.id}>
                      {editHead && (
                        <Table.Td>
                          <Checkbox aria-label={`Select ${rc.studentName}`} disabled={rc.status !== 'draft'} checked={selected.includes(rc.id)} onChange={(e) => setSelected((s) => (e.currentTarget.checked ? [...s, rc.id] : s.filter((x) => x !== rc.id)))} />
                        </Table.Td>
                      )}
                      <Table.Td>{rc.studentName}</Table.Td>
                      <Table.Td>{rc.average ?? '—'}</Table.Td>
                      <Table.Td>{rc.position ?? '—'}</Table.Td>
                      <Table.Td w={220}>
                        <RemarkCell rc={rc} field="teacherRemark" editable={editTeacher && rc.status === 'draft'} />
                      </Table.Td>
                      <Table.Td w={220}>
                        <RemarkCell rc={rc} field="headRemark" editable={editHead && rc.status === 'draft'} />
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={rc.status} />
                      </Table.Td>
                      <Table.Td>
                        <Can perm="academics:export">
                          <Button size="compact-xs" variant="light" onClick={() => void downloadFile('/report-cards/{id}/pdf', { id: rc.id }).catch((e) => notifications.show(notifyError(e)))}>
                            PDF
                          </Button>
                        </Can>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )
        }
      </QueryState>
    </>
  );
}
