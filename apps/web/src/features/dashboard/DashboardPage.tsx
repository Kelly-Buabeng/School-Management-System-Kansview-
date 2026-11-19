import { normDashboard } from '@/api/normalise';
import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/api/client';
import type { Page, Payment } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { EmptyState, Kpi, Money, PageHeader, QueryState, Section } from '@/components/ui';
import { formatDate, PAYMENT_METHOD_LABELS } from '@/lib/format';

/** KPI tiles may drop decimals (design): GH₵ 14,850. */
function wholeCedis(pesewas: number) {
  return `GH₵ ${Math.round(pesewas / 100).toLocaleString('en-GB')}`;
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Accra', hour: 'numeric', hour12: false }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.min(100, Math.round((value * 100) / Math.max(1, max)));
  return (
    <div role="img" aria-label={label} style={{ height: 10, background: 'var(--k-line)', borderRadius: 5, overflow: 'hidden', flex: 1 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--k-navy)', borderRadius: 5 }} />
    </div>
  );
}

/** Vertical day bars (plain CSS, no chart library). */
function WeekBars({ points }: { points: { date: string; ratePercent: number }[] }) {
  const last5 = points.slice(-5);
  if (!last5.length) return <EmptyState>No registers taken this week.</EmptyState>;
  const day = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 140 }} role="img" aria-label={`Attendance: ${last5.map((p) => `${day(p.date)} ${p.ratePercent}%`).join(', ')}`}>
      {last5.map((p) => (
        <div key={p.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
          <Text size="xs">{p.ratePercent}%</Text>
          <div style={{ width: '100%', height: `${Math.max(8, (p.ratePercent - 60) * 2.5)}px`, background: 'var(--k-navy)', borderRadius: 2 }} />
          <Text size="xs" c="dimmed">
            {day(p.date)}
          </Text>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { me, can } = useAuth();
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Record<string, unknown>>('/dashboard').then(normDashboard) });
  const recent = useQuery({
    queryKey: ['payments', 'recent'],
    queryFn: () => api.get<Page<Payment>>('/payments', { query: { pageSize: 4 } }),
    enabled: can('payments:read'),
  });
  return (
    <>
      <PageHeader title={`${greeting()}, ${me?.fullName?.split(' ')[0] ?? ''}`} subtitle={formatDate(new Date().toISOString())} />
      <QueryState query={query} label="Loading dashboard…">
        {(d) => {
          const enrolled = d.enrolmentByClass?.reduce((a, c) => a + c.count, 0);
          const lastAttendance = d.attendanceTrend?.at(-1);
          const maxClass = Math.max(1, ...(d.enrolmentByClass ?? []).map((c) => c.count));
          return (
            <Stack gap="md">
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
                {enrolled !== undefined && <Kpi label="Students enrolled" value={enrolled.toLocaleString("en-GB")} note={`${d.enrolmentByClass!.length} classes`} />}
                {d.todayPayments && <Kpi label="Collected today" value={wholeCedis(d.todayPayments.totalPesewas)} note={`${d.todayPayments.count} payments`} />}
                {d.arrears && <Kpi label="Outstanding fees" value={wholeCedis(d.arrears.totalPesewas)} note={d.arrears.studentCount ? `${d.arrears.studentCount} students` : undefined} />}
                {lastAttendance && <Kpi label="Attendance today" value={`${lastAttendance.ratePercent}%`} note={formatDate(lastAttendance.date)} />}
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, md: 3 }}>
                {d.enrolmentByClass && (
                  <Section title="Enrolment by class">
                    <Stack gap={8}>
                      {d.enrolmentByClass.map((c) => (
                        <Group key={c.className} gap="sm" wrap="nowrap">
                          <Text size="sm" w={80} style={{ flexShrink: 0 }}>
                            {c.className}
                          </Text>
                          <Bar value={c.count} max={maxClass} label={`${c.className}: ${c.count} of ${c.capacity}`} />
                          <Text size="sm" w={28} ta="right">
                            {c.count}
                          </Text>
                        </Group>
                      ))}
                    </Stack>
                  </Section>
                )}
                {(d.collection || d.birthdays) && (
                  <Section title={d.collection ? 'Fee collection against target' : 'Upcoming birthdays'}>
                    {d.collection && (
                      <>
                        <Text>
                          <span className="k-num" style={{ fontSize: 30 }}>
                            {wholeCedis(d.collection.collectedPesewas)}
                          </span>{' '}
                          <Text span size="sm" c="dimmed">
                            of {wholeCedis(d.collection.targetPesewas)}
                          </Text>
                        </Text>
                        <div style={{ margin: '12px 0' }}>
                          <Bar value={d.collection.collectedPesewas} max={d.collection.targetPesewas} label="Collected against billed" />
                        </div>
                        <Text size="sm" c="dimmed">
                          {Math.round((d.collection.collectedPesewas * 100) / Math.max(1, d.collection.targetPesewas))}% collected ({d.collection.termName}).
                          {d.arrears ? (
                            <>
                              {' '}
                              Arrears: <Money value={d.arrears.totalPesewas} owes />
                              {d.arrears.studentCount ? ` across ${d.arrears.studentCount} students.` : '.'}
                            </>
                          ) : null}
                        </Text>
                      </>
                    )}
                    {d.birthdays && (
                      <>
                        {d.collection && (
                          <Text fw={600} mt="md" mb={6}>
                            Upcoming birthdays
                          </Text>
                        )}
                        {d.birthdays.length === 0 ? (
                          <Text size="sm" c="dimmed">
                            None in the next 14 days.
                          </Text>
                        ) : (
                          <Stack gap={4}>
                            {d.birthdays.slice(0, 5).map((b) => (
                              <Text key={b.studentId} size="sm">
                                <Link to={`/students/${b.studentId}`}>{b.fullName}</Link>, {b.className} · {formatDate(b.date).replace(/ \d{4}$/, '')}
                              </Text>
                            ))}
                          </Stack>
                        )}
                      </>
                    )}
                  </Section>
                )}
                {d.attendanceTrend && (
                  <Section title="Attendance this week">
                    <WeekBars points={d.attendanceTrend} />
                  </Section>
                )}
                {can('payments:read') && (
                  <Section title="Recent payments">
                    <QueryState query={recent}>
                      {(p) => (
                        <Stack gap={0}>
                          {p.data.map((x) => (
                            <Group key={x.id} justify="space-between" py={10} style={{ borderTop: '1px solid var(--k-line)' }} wrap="nowrap">
                              <Text size="sm" truncate>
                                <Link to={`/finance/payments/${x.id}`} style={{ color: 'inherit' }}>
                                  {x.studentName}
                                </Link>{' '}
                                <Text span size="xs" c="dimmed">
                                  · {PAYMENT_METHOD_LABELS[x.method ?? ''] ?? x.method}
                                </Text>
                              </Text>
                              <Text size="sm" fw={600}>
                                <Money value={x.amountPesewas} />
                              </Text>
                            </Group>
                          ))}
                          {p.data.length === 0 && <EmptyState>No payments yet.</EmptyState>}
                        </Stack>
                      )}
                    </QueryState>
                    <Can perm="payments:create">
                      <Button component={Link} to="/finance/payments/new" variant="default" mt="sm">
                        Record a payment
                      </Button>
                    </Can>
                  </Section>
                )}
              </SimpleGrid>
              {d.widgets.length === 0 && <EmptyState>Nothing to show for your role yet.</EmptyState>}
            </Stack>
          );
        }}
      </QueryState>
    </>
  );
}
