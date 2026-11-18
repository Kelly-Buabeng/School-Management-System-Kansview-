import { Card, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/api/client';
import type { Guardian, Page } from '@/api/types';
import { EmptyState, PageHeader, QueryState } from '@/components/ui';
import { displayPhone } from '@/lib/format';

export default function GuardiansListPage() {
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q.trim(), 300);
  const isPhone = /^[+\d\s]{4,}$/.test(debounced);
  const query = useQuery({
    queryKey: ['guardians', 'list', debounced],
    queryFn: ({ signal }) => api.get<Page<Guardian>>('/guardians', { query: { ...(isPhone ? { phone: debounced } : { q: debounced }), pageSize: 50 }, signal }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Guardians" subtitle="Parents and guardians, with the children linked to them." />
      <TextInput size="md" label="Name or phone" placeholder="e.g. Owusu or 024 000 0100" value={q} onChange={(e) => setQ(e.currentTarget.value)} mb="md" maw={480} />
      <QueryState query={query}>
        {(d) =>
          d.data.length === 0 ? (
            <EmptyState>No guardian found.</EmptyState>
          ) : (
            <Card p={0}>
              <div className="table-scroll">
                <Table miw={480} highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>Phone</Table.Th>
                      <Table.Th>Children</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.data.map((g) => (
                      <Table.Tr key={g.id}>
                        <Table.Td>
                          <Text component={Link} to={`/guardians/${g.id}`} fw={600} c="navy.7">
                            {g.fullName}
                          </Text>
                        </Table.Td>
                        <Table.Td>{displayPhone(g.phonePrimary)}</Table.Td>
                        <Table.Td>{g.children?.map((c) => c.fullName).join(', ') || '—'}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </Card>
          )
        }
      </QueryState>
    </>
  );
}
