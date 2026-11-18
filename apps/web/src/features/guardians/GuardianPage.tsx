import { Button, Card, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, downloadFile } from '@/api/client';
import type { Guardian, GuardianBalance } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { Money, PageHeader, QueryState } from '@/components/ui';
import { displayPhone } from '@/lib/format';
import { GhanaCardReveal } from './GhanaCardReveal';

export default function GuardianPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const query = useQuery({ queryKey: ['guardian', id], queryFn: () => api.get<Guardian>('/guardians/{guardianId}', { path: { guardianId: id } }) });
  const balance = useQuery({
    queryKey: ['guardian', id, 'balance'],
    queryFn: () => api.get<GuardianBalance>('/guardians/{guardianId}/balance', { path: { guardianId: id } }),
    enabled: can('balances:read'),
  });
  return (
    <QueryState query={query} label="Loading parent…">
      {(g) => (
        <Stack>
          <PageHeader
            title={g.fullName}
            subtitle="Parent or guardian"
            actions={
              <Can perm="balances:export">
                <Button variant="light" onClick={() => void downloadFile('/guardians/{guardianId}/statement.pdf', { guardianId: id })}>
                  Family fee statement (PDF)
                </Button>
              </Can>
            }
          />
          <Card withBorder>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <div>
                <Text size="xs" c="dimmed">
                  Phone
                </Text>
                <a href={`tel:${g.phonePrimary}`}>{displayPhone(g.phonePrimary)}</a>
                {g.phoneSecondary && (
                  <>
                    {' · '}
                    <a href={`tel:${g.phoneSecondary}`}>{displayPhone(g.phoneSecondary)}</a>
                  </>
                )}
              </div>
              <div>
                <Text size="xs" c="dimmed">
                  Ghana Card
                </Text>
                <GhanaCardReveal guardianId={id} last4={g.ghanaCardLast4} />
              </div>
              <div>
                <Text size="xs" c="dimmed">
                  Occupation
                </Text>
                <Text size="sm">{[g.occupation, g.workplace].filter(Boolean).join(', ') || '—'}</Text>
              </div>
              {g.homeAddress !== undefined && (
                <div>
                  <Text size="xs" c="dimmed">
                    Home address
                  </Text>
                  <Text size="sm">{g.homeAddress || '—'}</Text>
                </div>
              )}
            </SimpleGrid>
          </Card>
          <Title order={2} size="h4">
            Children in this school
          </Title>
          {can('balances:read') ? (
            <QueryState query={balance}>
              {(b) => (
                <div className="table-scroll">
                  <Table miw={420}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Child</Table.Th>
                        <Table.Th>Class</Table.Th>
                        <Table.Th ta="right">Balance</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(g.children ?? []).map((c) => {
                        const row = b.children.find((x) => x.studentId === c.id);
                        return (
                          <Table.Tr key={c.id}>
                            <Table.Td>
                              <Link to={`/students/${c.id}`}>{c.fullName}</Link>
                            </Table.Td>
                            <Table.Td>{c.className}</Table.Td>
                            <Table.Td ta="right">{row ? <Money value={row.balancePesewas} owes /> : <Text size="xs" c="dimmed">Not fee payer</Text>}</Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                    <Table.Tfoot>
                      <Table.Tr>
                        <Table.Th colSpan={2}>Total for children this parent pays for</Table.Th>
                        <Table.Th ta="right">
                          <Money value={b.totalPesewas} owes />
                        </Table.Th>
                      </Table.Tr>
                    </Table.Tfoot>
                  </Table>
                </div>
              )}
            </QueryState>
          ) : (
            <Stack gap={4}>
              {(g.children ?? []).map((c) => (
                <Link key={c.id} to={`/students/${c.id}`}>
                  {c.fullName} · {c.className}
                </Link>
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </QueryState>
  );
}
