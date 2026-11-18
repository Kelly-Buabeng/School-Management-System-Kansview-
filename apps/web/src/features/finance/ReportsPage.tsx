import { Button, Group, Select, Table, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, downloadFile } from '@/api/client';
import type { ReportResult } from '@/api/types';
import { notifyError } from '@/components/ProblemAlert';
import { EmptyState, Money, PageHeader, QueryState } from '@/components/ui';
import { todayInAccra } from '@/lib/format';

const REPORTS = {
  collections: { label: 'Collections (money received)', path: '/reports/collections' as const },
  defaulters: { label: 'Defaulters (who owes)', path: '/reports/defaulters' as const },
  aging: { label: 'Arrears by age', path: '/reports/aging' as const },
  'daily-cash-up': { label: 'Daily cash-up', path: '/reports/daily-cash-up' as const },
  reconciliation: { label: 'Receipt check and reversals', path: '/reports/reconciliation' as const },
};
type Key = keyof typeof REPORTS;

export default function ReportsPage() {
  const [report, setReport] = useState<Key>('collections');
  const [groupBy, setGroupBy] = useState('method');
  const [from, setFrom] = useState(todayInAccra().slice(0, 8) + '01');
  const [to, setTo] = useState(todayInAccra());
  const params: Record<string, string> =
    report === 'collections' ? { groupBy, from, to } : report === 'daily-cash-up' ? { date: to } : report === 'reconciliation' ? { from, to } : {};
  const query = useQuery({
    queryKey: ['report', report, params],
    queryFn: () =>
      api.get<ReportResult>(REPORTS[report].path, { query: { ...params, format: 'json' } }).then((r) => ({
        ...r,
        // Money columns: flagged by the frontend mock (`money`) or by the API (`type: 'money'` / key ending in Pesewas).
        columns: r.columns.map((c) => ({ ...c, money: c.money || (c as { type?: string }).type === 'money' || c.key.endsWith('Pesewas') })),
      })),
  });
  const exp = useMutation({
    mutationFn: (format: 'xlsx' | 'pdf') => downloadFile(REPORTS[report].path, {}, { ...params, format }, `${report}-${to}.${format}`),
    onError: (e) => notifications.show(notifyError(e)),
  });
  return (
    <>
      <PageHeader
        title="Finance reports"
        actions={
          <>
            <Button variant="light" onClick={() => exp.mutate('xlsx')} loading={exp.isPending && exp.variables === 'xlsx'}>
              Export Excel
            </Button>
            <Button variant="light" onClick={() => exp.mutate('pdf')} loading={exp.isPending && exp.variables === 'pdf'}>
              Export PDF
            </Button>
          </>
        }
      />
      <Group mb="md" align="flex-end" wrap="wrap">
        <Select label="Report" data={Object.entries(REPORTS).map(([value, r]) => ({ value, label: r.label }))} value={report} onChange={(v) => v && setReport(v as Key)} allowDeselect={false} w={280} />
        {report === 'collections' && <Select label="Group by" data={[{ value: 'method', label: 'Payment method' }, { value: 'day', label: 'Day' }, { value: 'class', label: 'Class' }]} value={groupBy} onChange={(v) => v && setGroupBy(v)} allowDeselect={false} />}
        {(report === 'collections' || report === 'reconciliation') && <TextInput type="date" label="From" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />}
        {(report === 'collections' || report === 'reconciliation' || report === 'daily-cash-up') && <TextInput type="date" label={report === 'daily-cash-up' ? 'Date' : 'To'} value={to} onChange={(e) => setTo(e.currentTarget.value)} />}
      </Group>
      <QueryState query={query} label="Building report…">
        {(r) =>
          r.rows.length === 0 ? (
            <EmptyState>No data for this choice.</EmptyState>
          ) : (
            <div className="table-scroll">
              <Table striped fz="sm" miw={480}>
                <Table.Thead>
                  <Table.Tr>
                    {r.columns.map((c) => (
                      <Table.Th key={c.key} ta={c.money ? 'right' : undefined}>
                        {c.label}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {r.rows.map((row, i) => (
                    <Table.Tr key={i}>
                      {r.columns.map((c) => (
                        <Table.Td key={c.key} ta={c.money ? 'right' : undefined}>
                          {c.money ? <Money value={Number(row[c.key] ?? 0)} /> : String(row[c.key] ?? '')}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
                {r.totals && (
                  <Table.Tfoot>
                    <Table.Tr>
                      {r.columns.map((c) => (
                        <Table.Th key={c.key} ta={c.money ? 'right' : undefined}>
                          {r.totals![c.key] === undefined ? '' : c.money ? <Money value={Number(r.totals![c.key])} /> : String(r.totals![c.key])}
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Tfoot>
                )}
              </Table>
            </div>
          )
        }
      </QueryState>
    </>
  );
}
