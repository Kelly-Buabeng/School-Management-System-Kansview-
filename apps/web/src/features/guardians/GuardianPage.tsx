import { Button, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, downloadFile } from '@/api/client';
import type { Guardian, GuardianBalance } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError } from '@/components/ProblemAlert';
import { Money, PageHeader, QueryState, Section } from '@/components/ui';
import { displayPhone } from '@/lib/format';
import { GhanaCardReveal } from './GhanaCardReveal';

const rowStyle = { borderTop: '1px solid var(--k-line)', padding: '12px 0' } as const;

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
    <QueryState query={query} label="Loading guardian…">
      {(g) => (
        <Stack gap="md" maw={1000}>
          <PageHeader
            title={g.fullName}
            subtitle={
              <>
                {g.phonePrimary ? <a href={`tel:${g.phonePrimary}`}>{displayPhone(g.phonePrimary)}</a> : null}
                {g.phoneSecondary ? <> · <a href={`tel:${g.phoneSecondary}`}>{displayPhone(g.phoneSecondary)}</a></> : null}
                {g.email ? ` · ${g.email}` : ''}
                {g.occupation ? ` · ${[g.occupation, g.workplace].filter(Boolean).join(', ')}` : ''}
              </>
            }
            actions={
              <Can perm="balances:export">
                <Button variant="default" onClick={() => void downloadFile('/guardians/{guardianId}/statement.pdf', { guardianId: id }).catch((e) => notifications.show(notifyError(e)))}>
                  Family statement (PDF)
                </Button>
              </Can>
            }
          />
          <Section title="Linked children">
            {(g.children ?? []).length === 0 && <Text size="sm">No children linked.</Text>}
            {(g.children ?? []).map((c) => {
              const row = balance.data?.children.find((x) => x.studentId === c.id);
              return (
                <Group key={c.id} justify="space-between" style={rowStyle} wrap="nowrap">
                  <Text size="sm">
                    <Link to={`/students/${c.id}`} style={{ color: 'inherit' }}>
                      {c.fullName}
                    </Link>{' '}
                    · {c.className ?? '—'}
                  </Text>
                  <Text size="sm">{row ? <Money value={row.balancePesewas} owes /> : can('balances:read') ? <Text span size="xs" c="dimmed">Not the fee payer</Text> : null}</Text>
                </Group>
              );
            })}
            {balance.data && (
              <Group justify="space-between" pt="sm" style={{ borderTop: '2px solid var(--k-ink)' }}>
                <Text fw={600}>Combined balance</Text>
                <Text fw={700}>
                  <Money value={balance.data.totalPesewas} owes />
                </Text>
              </Group>
            )}
          </Section>
          <Section title="Details">
            <Stack gap="xs">
              <Group gap="xs">
                <Text size="sm" c="dimmed" w={110}>
                  Ghana Card
                </Text>
                <GhanaCardReveal guardianId={id} last4={g.ghanaCardLast4} />
              </Group>
              {g.homeAddress !== undefined && (
                <Group gap="xs">
                  <Text size="sm" c="dimmed" w={110}>
                    Home address
                  </Text>
                  <Text size="sm">{g.homeAddress || '—'}</Text>
                </Group>
              )}
            </Stack>
          </Section>
          <div className="k-msg k-msg-success">Brothers and sisters are linked through a shared parent or guardian. Check the children above belong to this family; to remove a wrong link, open the child's record.</div>
        </Stack>
      )}
    </QueryState>
  );
}
