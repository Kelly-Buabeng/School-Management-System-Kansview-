import { Avatar, Button, Card, Checkbox, Group, Pagination, Select, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '@/api/client';
import { classOptions, useClasses } from '@/api/queries';
import type { Page, StudentSummary } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { EmptyState, FeeBadge, PageHeader, Pill, QueryState, StatusBadge } from '@/components/ui';
import { STATUS_LABELS } from '@/lib/format';

const PAGE_SIZE = 25;
type Row = StudentSummary & { balancePesewas?: number; hasArrears?: boolean };
const feeStatus = (r: Row) => (r.balancePesewas === undefined ? null : r.balancePesewas <= 0 ? 'paid' : r.hasArrears ? 'arrears' : 'partial');

export default function StudentListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const classId = params.get('classId') ?? '';
  const status = params.get('status') ?? 'active';
  const fees = params.get('fees') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [debouncedQ] = useDebouncedValue(q, 300);
  const [selected, setSelected] = useState<string[]>([]);
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
    queryFn: ({ signal }) => api.get<Page<Row>>('/students', { query: { q: debouncedQ, classId, status, page, pageSize: PAGE_SIZE }, signal }),
    placeholderData: keepPreviousData,
  });
  const hasFees = Boolean(query.data?.data.some((r) => r.balancePesewas !== undefined));
  const rows = (query.data?.data ?? []).filter((r) => !fees || feeStatus(r) === fees);
  const toggle = (id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  return (
    <>
      <PageHeader
        title="Students"
        subtitle={query.data ? `${query.data.total} found` : undefined}
        actions={
          <Can perm="students:create">
            <Button component={Link} to="/students/new" size="md">
              New admission
            </Button>
          </Can>
        }
      />
      <Group mb="md" gap="sm" align="flex-end" wrap="wrap">
        <Select aria-label="Class" data={classOptions(classes.data)} value={classId || null} onChange={(v) => set('classId', v ?? '')} clearable placeholder="All classes" size="md" w={170} />
        {hasFees && (
          <Select
            aria-label="Fee status"
            data={[{ value: 'paid', label: 'Paid' }, { value: 'partial', label: 'Partial' }, { value: 'arrears', label: 'Arrears' }]}
            value={fees || null}
            onChange={(v) => set('fees', v ?? '')}
            clearable
            placeholder="All fee status"
            size="md"
            w={170}
          />
        )}
        <Select aria-label="Status" data={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} value={status || null} onChange={(v) => set('status', v ?? '')} clearable placeholder="Any status" size="md" w={160} />
        <TextInput aria-label="Name or student ID" value={q} onChange={(e) => set('q', e.currentTarget.value)} placeholder="Filter this list (name or KSV-… ID)" size="md" style={{ flex: '1 1 220px' }} />
        <Can perm="messages:send">
          <Button variant="default" size="md" disabled={selected.length === 0} onClick={() => navigate(`/messages?students=${selected.join(',')}`)}>
            Message guardians · {selected.length} selected
          </Button>
        </Can>
      </Group>
      <QueryState query={query} label="Loading students…">
        {(data) =>
          rows.length === 0 ? (
            <EmptyState>No students match these filters.</EmptyState>
          ) : (
            <>
              <Card p={0}>
                <div className="table-scroll">
                  <Table highlightOnHover miw={560}>
                    <Table.Thead>
                      <Table.Tr>
                        {can('messages:send') && (
                          <Table.Th w={44}>
                            <Checkbox aria-label="Select all on this page" checked={rows.length > 0 && rows.every((r) => selected.includes(r.id!))} onChange={(e) => setSelected(e.currentTarget.checked ? rows.map((r) => r.id!) : [])} />
                          </Table.Th>
                        )}
                        <Table.Th>Name</Table.Th>
                        <Table.Th>ID</Table.Th>
                        <Table.Th>Class</Table.Th>
                        <Table.Th>{hasFees ? 'Fees' : 'Status'}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rows.map((s) => (
                        <Table.Tr key={s.id}>
                          {can('messages:send') && (
                            <Table.Td>
                              <Checkbox aria-label={`Select ${s.fullName}`} checked={selected.includes(s.id!)} onChange={(e) => toggle(s.id!, e.currentTarget.checked)} />
                            </Table.Td>
                          )}
                          <Table.Td>
                            <Group gap="xs" wrap="nowrap">
                              <Avatar src={s.photoUrl} size="sm" alt="" />
                              <Text component={Link} to={`/students/${s.id}`} fw={600} size="sm" c="var(--k-ink)">
                                {s.fullName}
                              </Text>
                              {s.hasMedicalAlert && <Pill tone="arrears">Medical</Pill>}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{s.studentCode}</Text>
                          </Table.Td>
                          <Table.Td>{s.className ?? '—'}</Table.Td>
                          <Table.Td>{hasFees && s.balancePesewas !== undefined ? <FeeBadge balancePesewas={s.balancePesewas} arrears={s.hasArrears} /> : s.status && <StatusBadge status={s.status} label={STATUS_LABELS[s.status]} />}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              </Card>
              {data.total > PAGE_SIZE && <Pagination mt="md" total={Math.ceil(data.total / PAGE_SIZE)} value={page} onChange={(p) => set('page', String(p))} getControlProps={(c) => ({ 'aria-label': `${c} page` })} />}
            </>
          )
        }
      </QueryState>
    </>
  );
}
