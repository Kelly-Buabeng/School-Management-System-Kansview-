import { Avatar, Badge, Button, Group, Pagination, Select, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '@/api/client';
import { classOptions, useClasses } from '@/api/queries';
import type { Page, StudentSummary } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { EmptyState, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { STATUS_LABELS } from '@/lib/format';

const PAGE_SIZE = 25;

export default function StudentListPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const classId = params.get('classId') ?? '';
  const status = params.get('status') ?? 'active';
  const page = Number(params.get('page') ?? 1);
  const [debouncedQ] = useDebouncedValue(q, 300);
  const classes = useClasses();

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setParams(n, { replace: true });
  };

  const query = useQuery({
    queryKey: ['students', debouncedQ, classId, status, page],
    queryFn: ({ signal }) => api.get<Page<StudentSummary>>('/students', { query: { q: debouncedQ, classId, status, page, pageSize: PAGE_SIZE }, signal }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Students"
        subtitle={query.data ? `${query.data.total} found` : undefined}
        actions={
          <Can perm="students:create">
            <Button component={Link} to="/students/new">
              Admit a student
            </Button>
          </Can>
        }
      />
      <Group mb="md" gap="sm" align="flex-end" wrap="wrap">
        <TextInput label="Name or student ID" value={q} onChange={(e) => set('q', e.currentTarget.value)} placeholder="e.g. Mensah or KSV-23-…" style={{ flex: '1 1 220px' }} />
        <Select label="Class" data={classOptions(classes.data)} value={classId || null} onChange={(v) => set('classId', v ?? '')} clearable placeholder="All classes" style={{ flex: '1 1 160px' }} />
        <Select
          label="Status"
          data={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          value={status || null}
          onChange={(v) => set('status', v ?? '')}
          clearable
          placeholder="Any status"
          style={{ flex: '1 1 160px' }}
        />
      </Group>
      <QueryState query={query} label="Loading students…">
        {(data) =>
          data.data.length === 0 ? (
            <EmptyState>No students match these filters.</EmptyState>
          ) : (
            <>
              <div className="table-scroll">
                <Table striped highlightOnHover verticalSpacing="xs" miw={560}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>Student ID</Table.Th>
                      <Table.Th>Class</Table.Th>
                      <Table.Th>Status</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.data.map((s) => (
                      <Table.Tr key={s.id}>
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            <Avatar src={s.photoUrl} size="sm" alt="" />
                            <Text component={Link} to={`/students/${s.id}`} fw={600} c="blue.8" size="sm">
                              {s.fullName}
                            </Text>
                            {s.hasMedicalAlert && (
                              <Badge color="red" size="xs" title="Has a medical alert">
                                Medical
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {s.studentCode}
                          </Text>
                        </Table.Td>
                        <Table.Td>{s.className ?? '—'}</Table.Td>
                        <Table.Td>{s.status && <StatusBadge status={s.status} label={STATUS_LABELS[s.status]} />}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
              {data.total > PAGE_SIZE && <Pagination mt="md" total={Math.ceil(data.total / PAGE_SIZE)} value={page} onChange={(p) => set('page', String(p))} getControlProps={(c) => ({ 'aria-label': `${c} page` })} />}
            </>
          )
        }
      </QueryState>
    </>
  );
}
