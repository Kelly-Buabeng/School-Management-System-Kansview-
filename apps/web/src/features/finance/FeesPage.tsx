import { Accordion, Button, Group, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import { useCurrentTerm, useLevels } from '@/api/queries';
import type { FeeItem, FeeStructure, ListResponse } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { EmptyState, Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { formatCedis, tryParseCedis } from '@/lib/format';

function StructureEditor({ fs, items }: { fs: FeeStructure; items: FeeItem[] }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const editable = fs.status === 'draft' && can('fee_structures:update');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  useEffect(() => {
    setAmounts(Object.fromEntries(items.map((i) => [i.id, fs.lines.find((l) => l.feeItemId === i.id) ? formatCedis(fs.lines.find((l) => l.feeItemId === i.id)!.amountPesewas, { symbol: false }) : ''])));
  }, [fs, items]);
  const invalid = Object.values(amounts).some((v) => v.trim() !== '' && tryParseCedis(v) === null);
  const save = useMutation({
    mutationFn: () =>
      api.put('/fee-structures/{id}', {
        path: { id: fs.id },
        body: { lines: Object.entries(amounts).filter(([, v]) => (tryParseCedis(v) ?? 0) > 0).map(([feeItemId, v]) => ({ feeItemId, amountPesewas: tryParseCedis(v)! })) },
      }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Fee structure saved.' });
      void qc.invalidateQueries({ queryKey: ['fee-structures'] });
    },
  });
  const activate = useMutation({
    mutationFn: () => api.post('/fee-structures/{id}/activate', { path: { id: fs.id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fee-structures'] }),
    onError: (e) => notifications.show(notifyError(e)),
  });
  const total = Object.values(amounts).reduce((a, v) => a + (tryParseCedis(v) ?? 0), 0);
  return (
    <Stack>
      <Table fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Fee item</Table.Th>
            <Table.Th ta="right">Amount (GH₵)</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td>
                {i.name}
                {i.optional && <Text span size="xs" c="dimmed"> (optional — only for students who opt in)</Text>}
              </Table.Td>
              <Table.Td ta="right">
                {editable ? (
                  <TextInput aria-label={`Amount for ${i.name}`} size="xs" w={120} ml="auto" inputMode="decimal" value={amounts[i.id] ?? ''} onChange={(e) => { const v = e.currentTarget.value; setAmounts((a) => ({ ...a, [i.id]: v })); }} error={amounts[i.id] && tryParseCedis(amounts[i.id]!) === null ? 'Invalid' : undefined} />
                ) : (
                  <Money value={fs.lines.find((l) => l.feeItemId === i.id)?.amountPesewas ?? 0} />
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
        <Table.Tfoot>
          <Table.Tr>
            <Table.Th>Total (all items)</Table.Th>
            <Table.Th ta="right">
              <Money value={editable ? total : fs.totalPesewas} />
            </Table.Th>
          </Table.Tr>
        </Table.Tfoot>
      </Table>
      <ProblemAlert error={save.error} />
      <Group>
        {editable && (
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={invalid}>
            Save draft
          </Button>
        )}
        {fs.status === 'draft' && (
          <Can perm="fee_structures:activate">
            <Button
              color="green"
              variant="light"
              onClick={() =>
                modals.openConfirmModal({
                  title: 'Activate this fee structure?',
                  children: <Text size="sm">Once active it cannot be changed, and invoices for this term will use these amounts.</Text>,
                  labels: { confirm: 'Activate', cancel: 'Cancel' },
                  onConfirm: () => activate.mutate(),
                })
              }
            >
              Activate
            </Button>
          </Can>
        )}
      </Group>
    </Stack>
  );
}

export default function FeesPage() {
  const { terms, term } = useCurrentTerm();
  const [termId, setTermId] = useState<string | null>(null);
  const tid = termId ?? term?.id ?? null;
  const levels = useLevels();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ['fee-items'], queryFn: () => api.get<ListResponse<FeeItem>>('/fee-items').then((r) => r.data) });
  const structures = useQuery({ queryKey: ['fee-structures', tid], queryFn: () => api.get<ListResponse<FeeStructure>>('/fee-structures', { query: { termId: tid } }).then((r) => r.data), enabled: Boolean(tid) });
  const [newLevel, setNewLevel] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post('/fee-structures', { body: { termId: tid, levelId: newLevel } }),
    onSuccess: () => {
      setNewLevel(null);
      void qc.invalidateQueries({ queryKey: ['fee-structures'] });
    },
  });
  const missing = (levels.data ?? []).filter((l) => !(structures.data ?? []).some((s) => s.levelId === l.id));
  return (
    <>
      <PageHeader title="Fee structures" subtitle="What each level pays per term. Drafts can be edited; active ones are locked." />
      <Select label="Term" data={terms.map((t) => ({ value: t.id, label: t.name }))} value={tid} onChange={setTermId} maw={320} mb="md" />
      <QueryState query={structures}>
        {(list) => (
          <Stack>
            {list.length === 0 && <EmptyState>No fee structures for this term yet.</EmptyState>}
            <Accordion variant="separated" multiple>
              {list.map((fs) => (
                <Accordion.Item key={fs.id} value={fs.id}>
                  <Accordion.Control>
                    <Group justify="space-between" pr="sm" wrap="nowrap">
                      <Text fw={600}>{fs.levelName}</Text>
                      <Group gap="xs" wrap="nowrap">
                        <Money value={fs.totalPesewas} />
                        <StatusBadge status={fs.status} />
                      </Group>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>{items.data && <StructureEditor fs={fs} items={items.data} />}</Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
            <Can perm="fee_structures:create">
              {missing.length > 0 && (
                <Group align="flex-end">
                  <Select label="Add a draft for" data={missing.map((l) => ({ value: l.id, label: l.name }))} value={newLevel} onChange={setNewLevel} />
                  <Button onClick={() => create.mutate()} disabled={!newLevel} loading={create.isPending}>
                    Create draft
                  </Button>
                </Group>
              )}
              <ProblemAlert error={create.error} />
            </Can>
          </Stack>
        )}
      </QueryState>
    </>
  );
}
