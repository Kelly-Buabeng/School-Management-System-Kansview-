import { Alert, Button, Card, Group, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listOf, normCashUp } from '@/api/normalise';
import { api } from '@/api/client';
import type { CashUp, ListResponse, PaymentMethod } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';
import { Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { formatDate, money, PAYMENT_METHOD_LABELS, todayInAccra, tryParseCedis } from '@/lib/format';

const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[];

function CloseForm({ cu }: { cu: CashUp }) {
  const qc = useQueryClient();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const expectedTotal = METHODS.reduce((a, m) => a + (cu.expected[m] ?? 0), 0);
  const countedTotal = METHODS.reduce((a, m) => a + (tryParseCedis(counted[m] ?? '') ?? 0), 0);
  const variance = countedTotal - expectedTotal;
  const invalid = METHODS.some((m) => (counted[m] ?? '').trim() !== '' && tryParseCedis(counted[m]!) === null);
  const close = useMutation({
    mutationFn: () => api.post('/cash-ups/{id}/close', { path: { id: cu.id }, body: { counted: Object.fromEntries(METHODS.map((m) => [m, tryParseCedis(counted[m] ?? '') ?? 0])), note: note.trim() || undefined } }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Cash-up closed.' });
      void qc.invalidateQueries({ queryKey: ['cash-ups'] });
    },
  });
  return (
    <Stack>
      <div className="table-scroll">
        <Table miw={460}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Method</Table.Th>
              <Table.Th ta="right">System says</Table.Th>
              <Table.Th ta="right">You counted (GH₵)</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {METHODS.map((m) => (
              <Table.Tr key={m}>
                <Table.Td>{PAYMENT_METHOD_LABELS[m]}</Table.Td>
                <Table.Td ta="right">
                  <Money value={cu.expected[m] ?? 0} />
                </Table.Td>
                <Table.Td ta="right">
                  <TextInput aria-label={`Counted ${PAYMENT_METHOD_LABELS[m]}`} size="xs" w={120} ml="auto" inputMode="decimal" value={counted[m] ?? ''} onChange={(e) => { const v = e.currentTarget.value; setCounted((c) => ({ ...c, [m]: v })); }} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Th>Total</Table.Th>
              <Table.Th ta="right"><Money value={expectedTotal} /></Table.Th>
              <Table.Th ta="right"><Money value={countedTotal} /></Table.Th>
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      </div>
      <Alert color={variance === 0 ? 'green' : 'orange'}>{variance === 0 ? 'Counted matches the system.' : `Difference: ${money(variance)} (${variance > 0 ? 'more' : 'less'} than expected). Explain it below.`}</Alert>
      <Textarea label="Note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      <ProblemAlert error={close.error} />
      <Can perm="cash_up:close">
        <Button
          w="fit-content"
          disabled={invalid || (variance !== 0 && note.trim().length < 5)}
          loading={close.isPending}
          onClick={() =>
            modals.openConfirmModal({
              title: `Close cash-up for ${formatDate(cu.businessDate)}?`,
              children: <Text size="sm">After closing, payments for this day cannot be reversed without the administrator's approval.</Text>,
              labels: { confirm: 'Close cash-up', cancel: 'Cancel' },
              onConfirm: () => close.mutate(),
            })
          }
        >
          Close the day
        </Button>
      </Can>
    </Stack>
  );
}

export default function CashUpPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['cash-ups'], queryFn: () => api.get<unknown>('/cash-ups').then((r) => listOf<Record<string, unknown>>(r).map(normCashUp)) });
  const open = useMutation({ mutationFn: () => api.post('/cash-ups'), onSuccess: () => void qc.invalidateQueries({ queryKey: ['cash-ups'] }) });
  return (
    <>
      <PageHeader title="Daily cash-up" subtitle="Count what you received today and compare with the system before you go home." />
      <QueryState query={query}>
        {(list) => {
          const today = list.find((c) => c.businessDate === todayInAccra());
          return (
            <Stack maw={720}>
              <Card withBorder>
                <Title order={2} size="h4" mb="sm">
                  Today, {formatDate(todayInAccra())}
                </Title>
                {!today ? (
                  <Can perm="cash_up:create" fallback={<Text>No cash-up opened today.</Text>}>
                    <Button onClick={() => open.mutate()} loading={open.isPending}>
                      Open today's cash-up
                    </Button>
                    <ProblemAlert error={open.error} />
                  </Can>
                ) : today.status === 'closed' ? (
                  <Text>
                    Closed by {today.closedBy}. Difference <Money value={today.variancePesewas ?? 0} />.
                  </Text>
                ) : (
                  <>
                    <Text size="sm" mb="sm">{today.paymentCount} payment(s) so far.</Text>
                    <CloseForm cu={today} />
                  </>
                )}
              </Card>
              <Title order={2} size="h4">
                Earlier days
              </Title>
              <Table fz="sm">
                <Table.Tbody>
                  {list
                    .filter((c) => c !== today)
                    .map((c) => (
                      <Table.Tr key={c.id}>
                        <Table.Td>{formatDate(c.businessDate)}</Table.Td>
                        <Table.Td><StatusBadge status={c.status} /></Table.Td>
                        <Table.Td>{c.paymentCount} payments</Table.Td>
                        <Table.Td ta="right">Difference <Money value={c.variancePesewas ?? 0} /></Table.Td>
                      </Table.Tr>
                    ))}
                </Table.Tbody>
              </Table>
              <Group />
            </Stack>
          );
        }}
      </QueryState>
    </>
  );
}
