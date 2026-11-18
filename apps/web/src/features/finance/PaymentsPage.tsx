import { Button, Group, Pagination, Select, Table, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/api/client';
import type { Page, Payment } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { EmptyState, Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { formatDateTime, PAYMENT_METHOD_LABELS, todayInAccra } from '@/lib/format';

export default function PaymentsPage() {
  const [from, setFrom] = useState(todayInAccra().slice(0, 8) + '01');
  const [to, setTo] = useState(todayInAccra());
  const [method, setMethod] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['payments', { from, to, method, page }],
    queryFn: () => api.get<Page<Payment>>('/payments', { query: { from, to, method, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Payments"
        actions={
          <Can perm="payments:create">
            <Button component={Link} to="/finance/payments/new">
              Record payment
            </Button>
          </Can>
        }
      />
      <Group mb="md" align="flex-end" wrap="wrap">
        <TextInput type="date" label="From" value={from} onChange={(e) => { setFrom(e.currentTarget.value); setPage(1); }} />
        <TextInput type="date" label="To" value={to} onChange={(e) => { setTo(e.currentTarget.value); setPage(1); }} />
        <Select label="Method" clearable placeholder="All" data={Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))} value={method} onChange={(v) => { setMethod(v); setPage(1); }} />
      </Group>
      <QueryState query={query}>
        {(d) =>
          d.data.length === 0 ? (
            <EmptyState>No payments in this period.</EmptyState>
          ) : (
            <>
              <div className="table-scroll">
                <Table striped miw={640} fz="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Receipt</Table.Th>
                      <Table.Th>Student</Table.Th>
                      <Table.Th>Received</Table.Th>
                      <Table.Th>Method</Table.Th>
                      <Table.Th ta="right">Amount</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.data.map((p) => (
                      <Table.Tr key={p.id}>
                        <Table.Td>
                          <Link to={`/finance/payments/${p.id}`}>{p.receiptNo}</Link>
                        </Table.Td>
                        <Table.Td>{p.studentName}</Table.Td>
                        <Table.Td>{formatDateTime(p.receivedAt)}</Table.Td>
                        <Table.Td>{PAYMENT_METHOD_LABELS[p.method ?? ''] ?? p.method}</Table.Td>
                        <Table.Td ta="right">
                          <Money value={p.amountPesewas} />
                        </Table.Td>
                        <Table.Td>{p.status === 'reversed' && <StatusBadge status="reversed" />}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
              {d.total > 25 && <Pagination mt="md" total={Math.ceil(d.total / 25)} value={page} onChange={setPage} />}
            </>
          )
        }
      </QueryState>
    </>
  );
}
