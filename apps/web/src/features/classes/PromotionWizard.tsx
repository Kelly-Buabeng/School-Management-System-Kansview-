import { Alert, Badge, Button, Card, Checkbox, Group, Modal, Select, SimpleGrid, Stack, Stepper, Switch, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listOf } from '@/api/normalise';
import { api } from '@/api/client';
import { useAcademicYears, useClasses } from '@/api/queries';
import type { ListResponse, PromotionAction, PromotionItem, PromotionRun } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';
import { Money, PageHeader, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

export const ACTION_LABELS: Record<PromotionAction, string> = {
  promote: 'Move up',
  repeat: 'Repeat the class',
  skip: 'Skip a class',
  withdraw: 'Withdraw',
  transfer_out: 'Transfer out',
  graduate: 'Graduate (leave school)',
};
const NEEDS_REASON: PromotionAction[] = ['repeat', 'skip', 'withdraw', 'transfer_out'];

function ItemRow({ runId, item, policy, editable, onDirty }: { runId: string; item: PromotionItem; policy: PromotionRun['arrearsPolicy']; editable: boolean; onDirty: (id: string, dirty: boolean) => void }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<PromotionAction>(item.action);
  const [reason, setReason] = useState(item.overrideReason ?? '');
  const needsReason = NEEDS_REASON.includes(action) || (policy === 'block' && item.arrearsFlag && action === 'promote');
  const changed = action !== item.action || reason !== (item.overrideReason ?? '');
  useEffect(() => onDirty(item.id, editable && changed && needsReason), [item.id, editable, changed, needsReason, onDirty]);
  const save = useMutation({
    mutationFn: (body: { action: PromotionAction; overrideReason?: string }) => api.patch<PromotionItem>('/promotion-runs/{id}/items/{itemId}', { path: { id: runId, itemId: item.id }, body }),
    onSuccess: (updated) =>
      qc.setQueryData<PromotionRun>(['promotion-run', runId], (r) => (r ? { ...r, items: r.items.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)) } : r)),
  });
  const name = item.student.fullName ?? '';
  return (
    <Table.Tr bg={item.arrearsFlag ? 'var(--mantine-color-orange-0)' : undefined}>
      <Table.Td>
        <Text size="sm" fw={600}>
          {name}
        </Text>
        <Text size="xs" c="dimmed">
          {item.fromClassName}
        </Text>
      </Table.Td>
      <Table.Td>
        {item.arrearsFlag ? (
          <Badge color="orange" variant="light">
            Owes <Money value={item.outstandingPesewas} />
          </Badge>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {editable ? (
          <Select
            aria-label={`What happens to ${name}`}
            size="xs"
            w={190}
            data={Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))}
            value={action}
            allowDeselect={false}
            onChange={(v) => {
              const a = (v ?? 'promote') as PromotionAction;
              setAction(a);
              if (!NEEDS_REASON.includes(a) && !(policy === 'block' && item.arrearsFlag && a === 'promote')) save.mutate({ action: a, overrideReason: reason || undefined });
            }}
          />
        ) : (
          ACTION_LABELS[item.action]
        )}
      </Table.Td>
      <Table.Td>{item.targetClassName ?? (item.action === 'graduate' ? 'Alumni' : '—')}</Table.Td>
      <Table.Td>
        {editable && needsReason ? (
          <Group gap={4} wrap="nowrap">
            <TextInput aria-label={`Reason for ${name}`} size="xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} error={save.error ? ' ' : undefined} />
            <Button size="compact-xs" disabled={!changed || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate({ action, overrideReason: reason.trim() })}>
              Apply
            </Button>
          </Group>
        ) : (
          <Text size="xs">{item.overrideReason}</Text>
        )}
        {save.error && <Text size="xs" c="red.8">Not saved: {(save.error as Error).message}</Text>}
      </Table.Td>
    </Table.Tr>
  );
}

function UndoButton({ run }: { run: PromotionRun }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const undo = useMutation({
    mutationFn: () => api.post<PromotionRun>('/promotion-runs/{id}/undo', { path: { id: run.id }, body: { reason } }),
    onSuccess: (r) => {
      qc.setQueryData(['promotion-run', run.id], r);
      void qc.invalidateQueries({ queryKey: ['promotion-runs'] });
      setOpen(false);
    },
  });
  if (run.status !== 'committed' || !run.undoDeadline || new Date(run.undoDeadline) < new Date()) return null;
  return (
    <Can perm="promotion:undo">
      <Button color="orange" variant="outline" onClick={() => setOpen(true)}>
        Undo until {formatDateTime(run.undoDeadline)}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title="Undo this promotion?">
        <Stack>
          <Text size="sm">Every student goes back to the class and status they had before. This is only possible until {formatDateTime(run.undoDeadline)} and if nothing new depends on it.</Text>
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <ProblemAlert error={undo.error} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Keep promotion
            </Button>
            <Button color="orange" disabled={reason.trim().length < 5} loading={undo.isPending} onClick={() => undo.mutate()}>
              Undo promotion
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Can>
  );
}

export default function PromotionWizard() {
  const qc = useQueryClient();
  const years = useAcademicYears();
  const current = years.data?.find((y) => y.isCurrent);
  const [toYear, setToYear] = useState<string | null>(null);
  const classes = useClasses(current?.id);
  const [selected, setSelected] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [commitKey] = useState(() => newIdempotencyKey('promo'));
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const onDirty = useCallback((id: string, d: boolean) => setDirty((s) => (s.has(id) === d ? s : new Set([...s].filter((x) => x !== id).concat(d ? [id] : [])))), []);
  const runs = useQuery({ queryKey: ['promotion-runs'], queryFn: () => api.get<unknown>('/promotion-runs').then(listOf<PromotionRun>) });
  const run = useQuery({ queryKey: ['promotion-run', runId], queryFn: () => api.get<PromotionRun>('/promotion-runs/{id}', { path: { id: runId! } }), enabled: Boolean(runId) });

  const create = useMutation({
    mutationFn: () => api.post<PromotionRun>('/promotion-runs', { body: { fromAcademicYearId: current?.id, toAcademicYearId: toYear, classIds: selected } }),
    onSuccess: (r) => {
      qc.setQueryData(['promotion-run', r.id], r);
      setRunId(r.id);
      setStep(1);
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post<PromotionRun>('/promotion-runs/{id}/commit', { path: { id: runId! }, idempotencyKey: commitKey }),
    onSuccess: (r) => {
      qc.setQueryData(['promotion-run', r.id], r);
      void qc.invalidateQueries({ queryKey: ['promotion-runs'] });
      void qc.invalidateQueries({ queryKey: ['classes'] });
      setStep(3);
    },
  });

  const r = run.data;
  const counts = useMemo(() => {
    const c: Partial<Record<PromotionAction, number>> = {};
    for (const i of r?.items ?? []) c[i.action] = (c[i.action] ?? 0) + 1;
    return c;
  }, [r]);
  const blocked = (r?.items ?? []).filter((i) => r?.arrearsPolicy === 'block' && i.arrearsFlag && i.action === 'promote' && !i.overrideReason);
  const missingReasons = (r?.items ?? []).filter((i) => NEEDS_REASON.includes(i.action) && !i.overrideReason);
  const items = (r?.items ?? []).filter((i) => !onlyFlagged || i.arrearsFlag || i.action !== 'promote');

  return (
    <>
      <PageHeader title="End-of-year promotion" subtitle="Preview first, set exceptions, then commit. You can undo for a limited time." />
      <Stepper active={step} size="sm" mb="lg" wrap>
        <Stepper.Step label="Choose classes" />
        <Stepper.Step label="Preview and exceptions" />
        <Stepper.Step label="Confirm" />
        <Stepper.Step label="Done" />
      </Stepper>

      {step === 0 && (
        <Stack maw={760}>
          <Card withBorder>
            <SimpleGrid cols={{ base: 1, sm: 2 }} mb="md">
              <TextInput label="From year" value={current?.name ?? ''} readOnly />
              <Select label="Into year" data={(years.data ?? []).filter((y) => y.id !== current?.id && y.startDate > (current?.startDate ?? '')).map((y) => ({ value: y.id, label: y.name }))} value={toYear} onChange={setToYear} placeholder="Choose the next year" />
            </SimpleGrid>
            <Checkbox.Group label="Classes to promote" value={selected} onChange={setSelected}>
              <Group mt="xs">
                <Button size="compact-xs" variant="subtle" onClick={() => setSelected((classes.data ?? []).map((c) => c.id))}>
                  Select all
                </Button>
              </Group>
              <SimpleGrid cols={{ base: 2, sm: 4 }} mt="xs">
                {(classes.data ?? []).map((c) => (
                  <Checkbox key={c.id} value={c.id} label={`${c.name} (${c.enrolledCount})`} />
                ))}
              </SimpleGrid>
            </Checkbox.Group>
          </Card>
          <ProblemAlert error={create.error} />
          <Can perm="promotion:create">
            <Button w="fit-content" disabled={!toYear || selected.length === 0} loading={create.isPending} onClick={() => create.mutate()}>
              Build preview (nothing changes yet)
            </Button>
          </Can>
          {(runs.data ?? []).length > 0 && (
            <>
              <Title order={2} size="h5" mt="md">
                Earlier promotion runs
              </Title>
              <Table fz="sm">
                <Table.Tbody>
                  {runs.data!.map((x) => (
                    <Table.Tr key={x.id}>
                      <Table.Td>{formatDateTime(x.createdAt)}</Table.Td>
                      <Table.Td>{x.items?.length ?? (x as { itemCount?: number }).itemCount ?? 0} students</Table.Td>
                      <Table.Td>
                        <StatusBadge status={x.status} />
                      </Table.Td>
                      <Table.Td>
                        <Button size="compact-xs" variant="light" onClick={() => { setRunId(x.id); setStep(x.status === 'draft' ? 1 : 3); }}>
                          Open
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </Stack>
      )}

      {step === 1 && r && (
        <Stack>
          <Alert color={r.arrearsPolicy === 'block' ? 'orange' : 'blue'}>
            Arrears rule: <b>{r.arrearsPolicy === 'block' ? 'students who owe cannot move up without a reason' : r.arrearsPolicy === 'warn' ? 'students who owe are highlighted' : 'fees are not checked'}</b>. Change the action for any student who should not simply move up.
          </Alert>
          <Switch label="Show only students who owe or have an exception" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.currentTarget.checked)} />
          <div className="table-scroll">
            <Table miw={820} verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Student</Table.Th>
                  <Table.Th>Fees</Table.Th>
                  <Table.Th>Action</Table.Th>
                  <Table.Th>Next class</Table.Th>
                  <Table.Th>Reason</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((i) => (
                  <ItemRow key={i.id} runId={r.id} item={i} policy={r.arrearsPolicy} editable={r.status === 'draft'} onDirty={onDirty} />
                ))}
              </Table.Tbody>
            </Table>
          </div>
          <Group>
            <Button variant="default" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button onClick={() => setStep(2)} disabled={dirty.size > 0}>
              Next: confirm
            </Button>
            {dirty.size > 0 && (
              <Text size="sm" c="red.8" role="status">
                {dirty.size} student(s) have a change that is not applied yet — add the reason and press Apply.
              </Text>
            )}
          </Group>
        </Stack>
      )}

      {step === 2 && r && (
        <Stack maw={640}>
          <Card withBorder>
            <Title order={2} size="h4" mb="sm">
              Summary
            </Title>
            <Table>
              <Table.Tbody>
                {(Object.keys(ACTION_LABELS) as PromotionAction[])
                  .filter((a) => counts[a])
                  .map((a) => (
                    <Table.Tr key={a}>
                      <Table.Td>{ACTION_LABELS[a]}</Table.Td>
                      <Table.Td fw={700} ta="right" data-testid={`count-${a}`}>
                        {counts[a]}
                      </Table.Td>
                    </Table.Tr>
                  ))}
              </Table.Tbody>
            </Table>
          </Card>
          {blocked.length > 0 && <Alert color="red">{blocked.length} student(s) owe fees and need a reason before they can move up. Go back and add reasons, or choose another action.</Alert>}
          {missingReasons.length > 0 && <Alert color="red">{missingReasons.length} exception(s) still need a reason.</Alert>}
          <ProblemAlert error={commit.error} />
          <Group>
            <Button variant="default" onClick={() => setStep(1)}>
              Back
            </Button>
            <Can perm="promotion:commit">
              <Button
                color="green"
                disabled={blocked.length > 0 || missingReasons.length > 0}
                loading={commit.isPending}
                onClick={() =>
                  modals.openConfirmModal({
                    title: `Promote ${r.items.length} students now?`,
                    children: <Text size="sm">Class lists for the new year are created and old enrolments are closed. You can undo for a limited time afterwards.</Text>,
                    labels: { confirm: 'Commit promotion', cancel: 'Cancel' },
                    onConfirm: () => commit.mutate(),
                  })
                }
              >
                Commit promotion
              </Button>
            </Can>
          </Group>
        </Stack>
      )}

      {step === 3 && r && (
        <Stack maw={640}>
          {r.status === 'committed' ? (
            <Alert color="green" title="Promotion committed">
              {r.items.length} students were processed.
            </Alert>
          ) : r.status === 'undone' ? (
            <Alert color="gray" title="Promotion undone">
              Everyone is back where they were.
            </Alert>
          ) : null}
          <Group>
            <UndoButton run={r} />
            <Button variant="default" onClick={() => { setRunId(null); setStep(0); setSelected([]); }}>
              Start another
            </Button>
          </Group>
        </Stack>
      )}
    </>
  );
}
