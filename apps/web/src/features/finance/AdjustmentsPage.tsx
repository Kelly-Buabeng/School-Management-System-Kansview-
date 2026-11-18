import { Button, Card, Group, SegmentedControl, Select, SimpleGrid, Stack, Table, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/api/client';
import { useCurrentTerm } from '@/api/queries';
import type { Adjustment, ListResponse } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { StudentPicker } from '@/components/StudentPicker';
import { EmptyState, Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { formatDate, tryParseCedis } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

const TYPES: Record<string, string> = {
  discount: 'Discount',
  scholarship: 'Scholarship',
  bursary: 'Bursary',
  sibling_discount: 'Sibling discount',
  waiver: 'Waiver',
  refund: 'Refund',
  write_off: 'Write-off',
  manual_charge: 'Extra charge',
};

function RequestForm() {
  const qc = useQueryClient();
  const { term } = useCurrentTerm();
  const [studentId, setStudentId] = useState<string | null>(null);
  const [type, setType] = useState<string | null>('discount');
  const [mode, setMode] = useState<'amount' | 'percent'>('amount');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => newIdempotencyKey('adj'));
  const pct = /^\d{1,3}(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : null; // basis points, integer
  const amount = tryParseCedis(value);
  const valid = studentId && type && reason.trim().length >= 5 && (mode === 'amount' ? (amount ?? 0) > 0 : pct !== null && pct > 0 && pct <= 10000);
  const submit = useMutation({
    mutationFn: () => api.post('/adjustments', { idempotencyKey: key, body: { studentId, termId: term?.id, type, reason: reason.trim(), ...(mode === 'amount' ? { amountPesewas: amount } : { percentBasisPoints: pct }) } }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Request sent for approval. Another approver must approve it.' });
      setValue('');
      setReason('');
      setKey(newIdempotencyKey('adj'));
      void qc.invalidateQueries({ queryKey: ['adjustments'] });
    },
  });
  return (
    <Card withBorder maw={720}>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <StudentPicker value={studentId} onChange={setStudentId} required />
          <Select label="Type" data={Object.entries(TYPES).map(([v, l]) => ({ value: v, label: l }))} value={type} onChange={setType} />
          <SegmentedControl value={mode} onChange={(v) => setMode(v as 'amount' | 'percent')} data={[{ value: 'amount', label: 'Amount (GH₵)' }, { value: 'percent', label: 'Percentage of term fees' }]} />
          <TextInput label={mode === 'amount' ? 'Amount (GH₵)' : 'Percentage (%)'} inputMode="decimal" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
        </SimpleGrid>
        <Textarea label="Reason" description="Say who approved it in principle, e.g. board minute or head's letter." value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <ProblemAlert error={submit.error} />
        <Button w="fit-content" disabled={!valid} loading={submit.isPending} onClick={() => submit.mutate()}>
          Send for approval
        </Button>
      </Stack>
    </Card>
  );
}

export default function AdjustmentsPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('pending');
  const query = useQuery({ queryKey: ['adjustments', status], queryFn: () => api.get<ListResponse<Adjustment>>('/adjustments', { query: { status } }).then((r) => r.data) });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => (action === 'approve' ? api.post('/adjustments/{id}/approve', { path: { id } }) : api.post('/adjustments/{id}/reject', { path: { id } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['adjustments'] }),
    onError: (e) => notifications.show(notifyError(e)),
  });
  return (
    <>
      <PageHeader title="Discounts and adjustments" subtitle="Requests need a second person to approve. You cannot approve your own request." />
      <Tabs defaultValue={can('adjustments:approve') ? 'queue' : 'request'}>
        <Tabs.List mb="md">
          <Tabs.Tab value="queue">Requests</Tabs.Tab>
          {can('adjustments:create') && <Tabs.Tab value="request">New request</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="queue">
          <SegmentedControl mb="md" value={status} onChange={setStatus} data={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
          <QueryState query={query}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState>Nothing here.</EmptyState>
              ) : (
                <div className="table-scroll">
                  <Table miw={720} fz="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Student</Table.Th>
                        <Table.Th>Type</Table.Th>
                        <Table.Th>Value</Table.Th>
                        <Table.Th>Reason</Table.Th>
                        <Table.Th>Requested</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {list.map((a) => (
                        <Table.Tr key={a.id}>
                          <Table.Td>{a.studentName}</Table.Td>
                          <Table.Td>{TYPES[a.type] ?? a.type}</Table.Td>
                          <Table.Td>{a.amountPesewas ? <Money value={a.amountPesewas} /> : `${(a.percentBasisPoints ?? 0) / 100}%`}</Table.Td>
                          <Table.Td>{a.reason}</Table.Td>
                          <Table.Td>
                            {a.requestedBy}, {formatDate(a.requestedAt)}
                          </Table.Td>
                          <Table.Td>
                            {a.status === 'pending' ? (
                              <Can perm="adjustments:approve">
                                {a.requestedById === me?.id ? (
                                  <Text size="xs" c="dimmed">Your request — someone else must approve</Text>
                                ) : (
                                  <Group gap={4} wrap="nowrap">
                                    <Button size="compact-sm" color="green" onClick={() => decide.mutate({ id: a.id, action: 'approve' })}>
                                      Approve
                                    </Button>
                                    <Button size="compact-sm" variant="default" onClick={() => decide.mutate({ id: a.id, action: 'reject' })}>
                                      Reject
                                    </Button>
                                  </Group>
                                )}
                              </Can>
                            ) : (
                              <StatusBadge status={a.status} />
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )
            }
          </QueryState>
        </Tabs.Panel>
        <Tabs.Panel value="request">
          <RequestForm />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
