import { Accordion, Button, Card, Checkbox, Group, SegmentedControl, SimpleGrid, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, downloadFile } from '@/api/client';
import type { ClearanceItem, ListResponse, Withdrawal } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { StudentPicker } from '@/components/StudentPicker';
import { EmptyState, Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { formatDate } from '@/lib/format';

const ITEMS: { key: ClearanceItem; label: string }[] = [
  { key: 'fees', label: 'Fees cleared (bursar)' },
  { key: 'books', label: 'Books returned' },
  { key: 'uniform', label: 'Uniform / PE kit settled' },
  { key: 'property', label: 'School property returned' },
  { key: 'library', label: 'Library books returned' },
];

function WithdrawalCard({ w }: { w: Withdrawal }) {
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['withdrawals'] });
  const setItem = useMutation({
    mutationFn: ({ item, cleared }: { item: ClearanceItem; cleared: boolean }) => api.put('/withdrawals/{id}/clearance/{item}', { path: { id: w.id, item }, body: { cleared } }),
    onSuccess: refresh,
    onError: (e) => notifications.show(notifyError(e)),
  });
  const complete = useMutation({ mutationFn: () => api.post('/withdrawals/{id}/complete', { path: { id: w.id } }), onSuccess: refresh, onError: (e) => notifications.show(notifyError(e)) });
  const cancel = useMutation({ mutationFn: () => api.post('/withdrawals/{id}/cancel', { path: { id: w.id } }), onSuccess: refresh });
  const canFees = (me?.roles ?? []).some((r) => r === 'BURSAR' || r === 'ADMIN');
  const allClear = ITEMS.every((i) => w.clearance[i.key]?.cleared);
  const pending = w.status === 'pending_clearance';
  return (
    <Stack>
      <Text size="sm">
        {w.kind === 'transfer_out' ? `Transfer to ${w.destinationSchool ?? 'another school'}` : 'Withdrawal'} — {w.reason}. Started {formatDate(w.startedAt)}. Fee balance: <Money value={w.balancePesewas} owes />
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {ITEMS.map((i) => {
          const c = w.clearance[i.key];
          return (
            <Checkbox
              key={i.key}
              label={i.label}
              description={c?.cleared && c.by ? `${c.by}, ${formatDate(c.at)}` : undefined}
              checked={Boolean(c?.cleared)}
              disabled={!pending || !can('withdrawals:update') || (i.key === 'fees' && !canFees)}
              onChange={(e) => setItem.mutate({ item: i.key, cleared: e.currentTarget.checked })}
            />
          );
        })}
      </SimpleGrid>
      <Group>
        {pending && (
          <Can perm="withdrawals:complete">
            <Button
              disabled={!allClear}
              loading={complete.isPending}
              onClick={() =>
                modals.openConfirmModal({
                  title: `Complete the ${w.kind === 'transfer_out' ? 'transfer' : 'withdrawal'} of ${w.student.fullName}?`,
                  children: <Text size="sm">The student is taken off the class roll and marked as left. This cannot be undone here.</Text>,
                  labels: { confirm: 'Complete', cancel: 'Cancel' },
                  confirmProps: { color: 'red' },
                  onConfirm: () => complete.mutate(),
                })
              }
            >
              Complete
            </Button>
          </Can>
        )}
        {pending && (
          <Can perm="withdrawals:update">
            <Button variant="default" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              Cancel withdrawal
            </Button>
          </Can>
        )}
        <Can perm="withdrawals:export">
          <Button variant="light" onClick={() => void downloadFile('/withdrawals/{id}/transfer-letter.pdf', { id: w.id }).catch((e) => notifications.show(notifyError(e)))}>
            Transfer letter (PDF)
          </Button>
        </Can>
      </Group>
    </Stack>
  );
}

function StartForm() {
  const qc = useQueryClient();
  const [studentId, setStudentId] = useState<string | null>(null);
  const [kind, setKind] = useState<'withdrawal' | 'transfer_out'>('transfer_out');
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState('');
  const start = useMutation({
    mutationFn: () => api.post('/students/{id}/withdrawals', { path: { id: studentId! }, body: { kind, reason: reason.trim(), destinationSchool: destination.trim() || undefined } }),
    onSuccess: () => {
      setStudentId(null);
      setReason('');
      setDestination('');
      void qc.invalidateQueries({ queryKey: ['withdrawals'] });
    },
  });
  return (
    <Card withBorder maw={720}>
      <Stack>
        <StudentPicker value={studentId} onChange={setStudentId} required />
        <SegmentedControl value={kind} onChange={(v) => setKind(v as typeof kind)} data={[{ value: 'transfer_out', label: 'Moving to another school' }, { value: 'withdrawal', label: 'Leaving (no new school)' }]} />
        {kind === 'transfer_out' && <TextInput label="New school" value={destination} onChange={(e) => setDestination(e.currentTarget.value)} />}
        <Textarea label="Reason for leaving" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <ProblemAlert error={start.error} />
        <Button w="fit-content" disabled={!studentId || reason.trim().length < 3} loading={start.isPending} onClick={() => start.mutate()}>
          Start clearance
        </Button>
      </Stack>
    </Card>
  );
}

export default function WithdrawalsPage() {
  const query = useQuery({ queryKey: ['withdrawals'], queryFn: () => api.get<ListResponse<Withdrawal>>('/withdrawals').then((r) => r.data) });
  return (
    <>
      <PageHeader title="Withdrawals and transfers" subtitle="Every item must be cleared before a student is taken off the roll." />
      <Stack>
        <Can perm="withdrawals:create">
          <StartForm />
        </Can>
        <QueryState query={query}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>No withdrawals.</EmptyState>
            ) : (
              <Accordion variant="separated">
                {list.map((w) => (
                  <Accordion.Item key={w.id} value={w.id}>
                    <Accordion.Control>
                      <Group justify="space-between" pr="sm">
                        <Text fw={600} component={Link} to={`/students/${w.student.id}`} onClick={(e) => e.stopPropagation()}>
                          {w.student.fullName}
                        </Text>
                        <StatusBadge status={w.status === 'pending_clearance' ? 'pending' : w.status === 'completed' ? 'committed' : 'undone'} label={w.status.replace('_', ' ')} />
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <WithdrawalCard w={w} />
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            )
          }
        </QueryState>
      </Stack>
    </>
  );
}
