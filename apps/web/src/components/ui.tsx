import { Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import type { CSSProperties, ReactNode } from 'react';
import { money } from '@/lib/format';
import { ProblemAlert } from './ProblemAlert';

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="lg" wrap="wrap" gap="sm">
      <Stack gap={4} style={{ minWidth: 0 }}>
        <Title order={1}>{title}</Title>
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

/** White card with an optional section title (design: cards on Paper). */
export function Section({ title, children, actions, style }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; style?: CSSProperties }) {
  return (
    <Card style={style}>
      {(title || actions) && (
        <Group justify="space-between" mb="sm" wrap="wrap">
          {title && (
            <Title order={2} size="h3" ff="var(--mantine-font-family)" fw={600}>
              {title}
            </Title>
          )}
          {actions}
        </Group>
      )}
      {children}
    </Card>
  );
}

/** KPI tile: label, big serif number, small note. */
export function Kpi({ label, value, note, danger }: { label: string; value: ReactNode; note?: ReactNode; danger?: boolean }) {
  return (
    <Card>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text className="k-num" fz={30} lh={1.2} my={4} c={danger ? 'var(--k-red)' : undefined}>
        {value}
      </Text>
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </Card>
  );
}

/** Inline message box (success / warning / danger). */
export function Message({ kind = 'success', children, role }: { kind?: 'success' | 'warning' | 'danger'; children: ReactNode; role?: string }) {
  return (
    <div className={`k-msg k-msg-${kind}`} role={role ?? (kind === 'success' ? 'status' : 'alert')}>
      {children}
    </div>
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
  // Red is reserved for arrears: only amounts owed are red.
  const colour = owes && value !== null && value !== undefined && value > 0 ? 'var(--k-red)' : undefined;
  return (
    <Text span className="money" c={colour} inherit>
      {money(value)}
    </Text>
  );
}

const PILL: Record<'paid' | 'partial' | 'arrears' | 'neutral' | 'info', CSSProperties> = {
  paid: { background: 'var(--k-success)', color: 'var(--k-success-ink)' },
  partial: { background: 'var(--k-warning)', color: 'var(--k-warning-ink)' },
  arrears: { background: 'var(--k-red-tint)', color: 'var(--k-red)' },
  neutral: { background: '#ece8e1', color: 'var(--k-ink)' },
  info: { background: '#e3e9f4', color: 'var(--k-navy)' },
};

/** Pill badge in the design's three tones (plus neutral/info for non-money states). */
export function Pill({ tone, children }: { tone: keyof typeof PILL; children: ReactNode }) {
  return (
    <span style={{ ...PILL[tone], display: 'inline-block', borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', lineHeight: '18px' }}>{children}</span>
  );
}

/** Fee status from a balance: Paid (≤ 0), Partial (owes this term only), Arrears (owes from earlier terms). */
export function FeeBadge({ balancePesewas, arrears }: { balancePesewas: number; arrears?: boolean }) {
  if (balancePesewas <= 0) return <Pill tone="paid">Paid</Pill>;
  return arrears ? <Pill tone="arrears">Arrears</Pill> : <Pill tone="partial">Partial</Pill>;
}

const STATUS_TONES: Record<string, keyof typeof PILL> = {
  active: 'paid',
  confirmed: 'paid',
  approved: 'paid',
  published: 'paid',
  committed: 'paid',
  closed: 'neutral',
  applicant: 'info',
  open: 'info',
  pending: 'partial',
  draft: 'partial',
  reversed: 'arrears',
  rejected: 'neutral',
  withdrawn: 'neutral',
  transferred_out: 'neutral',
  alumni: 'info',
  undone: 'neutral',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Pill tone={STATUS_TONES[status] ?? 'neutral'}>{label ?? status.replace(/_/g, ' ')}</Pill>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Text c="dimmed" ta="center" py="lg">
      {children}
    </Text>
  );
}

/** Selection chip (audience pickers, term tabs): navy filled when selected, navy outline otherwise. */
export function Chip({ selected, onClick, children, ...rest }: { selected: boolean; onClick: () => void; children: ReactNode; 'aria-label'?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      {...rest}
      style={{
        minHeight: 44,
        padding: '0 16px',
        borderRadius: 6,
        border: '1px solid var(--k-navy)',
        background: selected ? 'var(--k-navy)' : '#fff',
        color: selected ? '#fff' : 'var(--k-navy)',
        font: 'inherit',
        fontSize: 16,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/** Wizard stepper as pills: "1. Select class · 2. Preview …". */
export function StepPills({ steps, active }: { steps: string[]; active: number }) {
  return (
    <ol aria-label="Steps" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === active ? 'step' : undefined}
          style={{
            borderRadius: 999,
            padding: '4px 12px',
            fontSize: 14,
            background: i === active ? 'var(--k-navy)' : i < active ? '#cfd8ea' : '#e5e0d8',
            color: i === active ? '#fff' : 'var(--k-ink)',
          }}
        >
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}
