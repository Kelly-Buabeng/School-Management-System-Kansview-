import { listOf, normLedgerEntry } from '@/api/normalise';
import { Group, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Balance, Ledger } from '@/api/types';
import { EmptyState, Money, QueryState } from '@/components/ui';
import { formatDate } from '@/lib/format';

/** Student ledger with running balance (positive = owes, negative = credit). */
export function LedgerTable({ studentId }: { studentId: string }) {
  const query = useQuery({ queryKey: ['ledger', studentId], queryFn: () => api.get<Ledger>('/students/{id}/ledger', { path: { id: studentId } }).then((l) => ({ ...l, entries: listOf<Record<string, unknown>>(l.entries).map(normLedgerEntry) })) });
  return (
    <QueryState query={query} label="Loading account…">
      {(l) =>
        l.entries.length === 0 ? (
          <EmptyState>No charges or payments yet.</EmptyState>
        ) : (
          <div className="table-scroll">
            <Table striped verticalSpacing={4} miw={620} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Details</Table.Th>
                  <Table.Th>Ref.</Table.Th>
                  <Table.Th ta="right">Charged</Table.Th>
                  <Table.Th ta="right">Paid / credited</Table.Th>
                  <Table.Th ta="right">Balance</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {l.entries.map((e) => (
                  <Table.Tr key={e.id}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(e.postedAt)}</Table.Td>
                    <Table.Td>{e.description}</Table.Td>
                    <Table.Td>{e.reference ?? ''}</Table.Td>
                    <Table.Td ta="right">{e.debitPesewas ? <Money value={e.debitPesewas} /> : ''}</Table.Td>
                    <Table.Td ta="right">{e.creditPesewas ? <Money value={e.creditPesewas} /> : ''}</Table.Td>
                    <Table.Td ta="right" fw={600}>
                      <Money value={e.runningBalancePesewas} owes />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )
      }
    </QueryState>
  );
}

export function BalanceSummary({ studentId }: { studentId: string }) {
  const query = useQuery({ queryKey: ['balance', studentId], queryFn: () => api.get<Balance>('/students/{id}/balance', { path: { id: studentId } }) });
  return (
    <QueryState query={query}>
      {(b) => (
        <Group gap="xl" wrap="wrap">
          <div>
            <Text size="xs" c="dimmed">
              {(b.balancePesewas ?? 0) < 0 ? 'In credit' : 'Owes in total'}
            </Text>
            <Text fw={700} size="xl">
              <Money value={Math.abs(b.balancePesewas ?? 0)} />
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">
              Arrears from earlier terms
            </Text>
            <Text fw={600}>
              <Money value={b.arrearsPesewas ?? 0} />
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">
              Last payment
            </Text>
            <Text fw={600}>{formatDate(b.lastPaymentAt ?? null)}</Text>
          </div>
        </Group>
      )}
    </QueryState>
  );
}
