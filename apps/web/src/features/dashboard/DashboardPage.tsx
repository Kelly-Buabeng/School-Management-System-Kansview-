import { normDashboard } from '@/api/normalise';
import { Button, Card, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '@/api/client';
import type { DashboardData } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { EmptyState, Money, PageHeader, QueryState } from '@/components/ui';
import { formatDate, money } from '@/lib/format';

function Widget({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder component="section" aria-label={title}>
      <Title order={2} size="h5" mb="sm">
        {title}
      </Title>
      {children}
    </Card>
  );
}

/** Tiny SVG line chart (no chart library: keeps the page light). */
function TrendLine({ points }: { points: { date: string; ratePercent: number }[] }) {
  if (points.length < 2) return <EmptyState>Not enough days yet.</EmptyState>;
  const w = 300;
  const h = 90;
  const min = Math.min(80, ...points.map((p) => p.ratePercent));
  const x = (i: number) => (i * w) / (points.length - 1);
  const y = (v: number) => h - ((v - min) / (100 - min || 1)) * (h - 10) - 5;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.ratePercent).toFixed(1)}`).join(' ');
  const last = points.at(-1)!;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`Attendance over the last ${points.length} school days, latest ${last.ratePercent}%`}>
        <line x1={0} x2={w} y1={y(90)} y2={y(90)} stroke="#ced4da" strokeDasharray="4 4" />
        <path d={d} fill="none" stroke="#1971c2" strokeWidth={2.5} />
        {points.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.ratePercent)} r={3} fill="#1971c2">
            <title>{`${formatDate(p.date)}: ${p.ratePercent}%`}</title>
          </circle>
        ))}
      </svg>
      <figcaption>
        <Text size="sm">
          Latest: <b>{last.ratePercent}%</b> on {formatDate(last.date)} (dashed line = 90%)
        </Text>
      </figcaption>
    </figure>
  );
}

export default function DashboardPage() {
  const { me } = useAuth();
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Record<string, unknown>>('/dashboard').then(normDashboard) });
  return (
    <>
      <PageHeader
        title={`Good day, ${me?.fullName?.split(' ')[0] ?? ''}`}
        subtitle={formatDate(new Date().toISOString())}
        actions={
          <>
            <Can perm="payments:create">
              <Button component={Link} to="/finance/payments/new">
                Record payment
              </Button>
            </Can>
            <Can perm="students:create">
              <Button component={Link} to="/students/new" variant="light">
                Admit a student
              </Button>
            </Can>
            <Can perm="attendance:update">
              <Button component={Link} to="/attendance" variant="light">
                Take attendance
              </Button>
            </Can>
          </>
        }
      />
      <QueryState query={query} label="Loading dashboard…">
        {(d) => (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {d.collection && (
              <Widget title="Fees collected this term">
                <Text fz={26} fw={700} className="money">
                  {money(d.collection.collectedPesewas)}
                </Text>
                <Text size="sm" c="dimmed" mb={6}>
                  of {money(d.collection.targetPesewas)} billed ({d.collection.termName})
                </Text>
                <Progress value={d.collection.targetPesewas ? Math.min(100, (d.collection.collectedPesewas * 100) / d.collection.targetPesewas) : 0} size="lg" aria-label="Collected against billed" />
              </Widget>
            )}
            {d.todayPayments && (
              <Widget title="Today's payments">
                <Text fz={26} fw={700}>
                  <Money value={d.todayPayments.totalPesewas} />
                </Text>
                <Text size="sm">{d.todayPayments.count} receipt(s)</Text>
                <Button component={Link} to="/finance/cash-up" variant="subtle" size="xs" mt="xs" px={0}>
                  Go to cash-up →
                </Button>
              </Widget>
            )}
            {d.arrears && (
              <Widget title="Money owed">
                <Text fz={26} fw={700} c="red.8" className="money">
                  {money(d.arrears.totalPesewas)}
                </Text>
                <Text size="sm" mb="xs">
                  {d.arrears.studentCount} students owe
                </Text>
                <Stack gap={2}>
                  {d.arrears.topClasses.map((c) => (
                    <Group key={c.className} justify="space-between">
                      <Text size="sm">{c.className}</Text>
                      <Text size="sm">
                        <Money value={c.outstandingPesewas} />
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </Widget>
            )}
            {d.attendanceTrend && (
              <Widget title="Attendance trend">
                <TrendLine points={d.attendanceTrend} />
              </Widget>
            )}
            {d.enrolmentByClass && (
              <Widget title="Enrolment by class">
                <Stack gap={4}>
                  {d.enrolmentByClass.map((c) => (
                    <div key={c.className}>
                      <Group justify="space-between">
                        <Text size="xs">{c.className}</Text>
                        <Text size="xs">
                          {c.count}/{c.capacity}
                        </Text>
                      </Group>
                      <Progress value={(c.count * 100) / Math.max(1, c.capacity)} size="sm" color={c.count >= c.capacity ? 'red' : 'blue'} aria-label={`${c.className} ${c.count} of ${c.capacity}`} />
                    </div>
                  ))}
                </Stack>
              </Widget>
            )}
            {d.birthdays && (
              <Widget title="Birthdays (next 14 days)">
                {d.birthdays.length === 0 ? (
                  <EmptyState>None.</EmptyState>
                ) : (
                  <Stack gap={2}>
                    {d.birthdays.slice(0, 10).map((b) => (
                      <Text key={b.studentId} size="sm">
                        {formatDate(b.date)} — <Link to={`/students/${b.studentId}`}>{b.fullName}</Link> ({b.className}) turns {b.turning}
                      </Text>
                    ))}
                  </Stack>
                )}
              </Widget>
            )}
            {d.widgets.length === 0 && <EmptyState>Nothing to show for your role yet.</EmptyState>}
          </SimpleGrid>
        )}
      </QueryState>
    </>
  );
}
