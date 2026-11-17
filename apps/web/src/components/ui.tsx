import { Badge, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { money } from '@/lib/format';
import { ProblemAlert } from './ProblemAlert';

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="md" wrap="wrap" gap="sm">
      <Stack gap={2}>
        <Title order={1} size="h2">
          {title}
        </Title>
        {subtitle && (
          <Text c="dimmed" size="sm">
            {subtitle}
          </Text>
        )}
      </Stack>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

/** Loading / error / content for a query. */
export function QueryState<T>({ query, children, label = 'Loading…' }: { query: { data: T | undefined; error: unknown; isLoading: boolean; refetch: () => unknown }; children: (data: T) => ReactNode; label?: string }) {
  if (query.isLoading)
    return (
      <Center py="xl" aria-live="polite">
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm">{label}</Text>
        </Group>
      </Center>
    );
  if (query.error) return <ProblemAlert error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}

export function Money({ value, owes }: { value: number | null | undefined; owes?: boolean }) {
  const colour = owes && value !== null && value !== undefined ? (value > 0 ? 'red.8' : value < 0 ? 'green.8' : undefined) : undefined;
  return (
    <Text span className="money" c={colour} inherit>
      {money(value)}
    </Text>
  );
}

const STATUS_COLOURS: Record<string, string> = {
  active: 'green',
  applicant: 'blue',
  withdrawn: 'gray',
  transferred_out: 'gray',
  alumni: 'violet',
  confirmed: 'green',
  reversed: 'red',
  pending: 'yellow',
  approved: 'green',
  rejected: 'red',
  draft: 'yellow',
  published: 'green',
  committed: 'green',
  undone: 'gray',
  open: 'blue',
  closed: 'gray',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge color={STATUS_COLOURS[status] ?? 'gray'} variant="light">
      {label ?? status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Text c="dimmed" ta="center" py="lg">
      {children}
    </Text>
  );
}
