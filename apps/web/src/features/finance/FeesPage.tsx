import { Button, Checkbox, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { formatCedis } from '@sms/shared';
import { listOf, normFeeItem } from '@/api/normalise';
import { api } from '@/api/client';
import { useCurrentTerm, useLevels } from '@/api/queries';
import type { FeeItem, FeeStructure } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { Chip, Message, Money, PageHeader, QueryState, Section, StatusBadge } from '@/components/ui';
import { money, tryParseCedis } from '@/lib/format';

const plain = (p: number) => formatCedis(p, { symbol: false }).replace(/,/g, '');

function Editor({ fs, items }: { fs: FeeStructure; items: FeeItem[] }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const editable = fs.status === 'draft' && can('fee_structures:update');
  const [rows, setRows] = useState<{ feeItemId: string; amount: string }[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => setRows((fs.lines ?? []).map((l) => ({ feeItemId: l.feeItemId, amount: plain(l.amountPesewas) }))), [fs]);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const invalid = rows.some((r) => tryParseCedis(r.amount) === null);
  const compulsory = rows.filter((r) => !itemOf(r.feeItemId)?.optional).reduce((a, r) => a + (tryParseCedis(r.amount) ?? 0), 0);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['fee-structures'] });
    void qc.invalidateQueries({ queryKey: ['fee-structure', fs.id] });
  };
  const save = useMutation({
    mutationFn: () => api.put('/fee-structures/{id}', { path: { id: fs.id }, body: { lines: rows.map((r) => ({ feeItemId: r.feeItemId, amountPesewas: tryParseCedis(r.amount) ?? 0 })) } }),
    onSuccess: () => {
      notifications.show({ color: 'navy', message: 'Fee setup saved.' });
      refresh();
    },
  });
  const activate = useMutation({ mutationFn: () => api.post('/fee-structures/{id}/activate', { path: { id: fs.id } }), onSuccess: refresh, onError: (e) => notifications.show(notifyError(e)) });
  const unused = items.filter((i) => i.active && !rows.some((r) => r.feeItemId === i.id));

  return (
    <Stack gap="md">
      <Section
        title={
          <Group gap="xs">
            {fs.levelName}
            <StatusBadge status={fs.status} label={fs.status === 'active' ? 'Active (locked)' : fs.status} />
          </Group>
        }
      >
        {rows.map((r, i) => {
          const item = itemOf(r.feeItemId);
          return (
            <SimpleGrid key={r.feeItemId} cols={{ base: 1, sm: 4 }} spacing="sm" py="sm" style={{ borderTop: '1px solid var(--k-line)', alignItems: 'end' }}>
              <TextInput label="Fee name" value={item?.name ?? 'Fee'} readOnly />
              <TextInput
                label="Amount (GH₵)"
                inputMode="decimal"
                value={r.amount}
                readOnly={!editable}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: v } : x)));
                }}
                error={tryParseCedis(r.amount) === null ? 'Enter an amount, e.g. 1500' : undefined}
              />
              <Checkbox label="Optional" checked={Boolean(item?.optional)} readOnly disabled description={item?.optional ? 'Charged only when picked' : undefined} mb={8} />
              {editable && (
                <Button variant="outline" color="red" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove ${item?.name ?? 'fee'}`}>
                  Remove
                </Button>
              )}
            </SimpleGrid>
          );
        })}
        {editable && (
          <Group gap="sm" py="sm" style={{ borderTop: '1px solid var(--k-line)' }} align="flex-end" wrap="wrap">
            <Select aria-label="Fee to add" placeholder="Choose a fee item" data={unused.map((i) => ({ value: i.id, label: i.name }))} value={adding} onChange={setAdding} w={220} />
            <Button
              variant="default"
              style={{ borderStyle: 'dashed', borderColor: 'var(--k-navy)', color: 'var(--k-navy)' }}
              disabled={!adding}
              onClick={() => {
                setRows((rs) => [...rs, { feeItemId: adding!, amount: '' }]);
                setAdding(null);
              }}
            >
              Add a fee
            </Button>
          </Group>
        )}
        <Group justify="space-between" pt="sm" style={{ borderTop: '2px solid var(--k-ink)' }}>
          <Text fw={600}>Compulsory total per student</Text>
          <Text fw={700}>
            <Money value={compulsory} />
          </Text>
        </Group>
      </Section>
      <ProblemAlert error={save.error} />
      <Group>
        {editable && (
          <Button size="md" onClick={() => save.mutate()} loading={save.isPending} disabled={invalid}>
            Save fee setup
          </Button>
        )}
        {fs.status === 'draft' && (
          <Can perm="fee_structures:activate">
            <Button
              size="md"
              variant="default"
              onClick={() =>
                modals.openConfirmModal({
                  title: 'Activate this fee setup?',
                  children: <Text size="sm">Once active it cannot be changed, and invoices for this term will use these amounts ({money(compulsory)} compulsory per student).</Text>,
                  labels: { confirm: 'Activate', cancel: 'Cancel' },
                  onConfirm: () => activate.mutate(),
                })
              }
            >
              Activate
            </Button>
          </Can>
        )}
      </Group>
    </Stack>
  );
}

function Loader({ fs, items }: { fs: FeeStructure; items: FeeItem[] }) {
  const detail = useQuery({ queryKey: ['fee-structure', fs.id], queryFn: () => api.get<FeeStructure>('/fee-structures/{id}', { path: { id: fs.id } }), enabled: !fs.lines });
  if (fs.lines) return <Editor fs={fs} items={items} />;
  return <QueryState query={detail}>{(full) => <Editor fs={{ ...fs, ...full, lines: full.lines ?? [] }} items={items} />}</QueryState>;
}

export default function FeesPage() {
  const qc = useQueryClient();
  const { terms, term, year } = useCurrentTerm();
  const levels = useLevels();
  const [termId, setTermId] = useState<string | null>(null);
  const [levelId, setLevelId] = useState<string | null>(null);
  const tid = termId ?? term?.id ?? null;
  const lid = levelId ?? levels.data?.[0]?.id ?? null;
  const yearTerms = terms.filter((t) => t.academicYearId === (terms.find((x) => x.id === tid)?.academicYearId ?? year?.id));
  const items = useQuery({ queryKey: ['fee-items'], queryFn: () => api.get<unknown>('/fee-items').then((r) => listOf<Record<string, unknown>>(r).map(normFeeItem)) });
  const structures = useQuery({ queryKey: ['fee-structures', tid], queryFn: () => api.get<unknown>('/fee-structures', { query: { termId: tid } }).then(listOf<FeeStructure>), enabled: Boolean(tid) });
  const tIndex = terms.findIndex((t) => t.id === tid);
  const prevTermId = tIndex > 0 ? terms[tIndex - 1]!.id : null;
  const prev = useQuery({ queryKey: ['fee-structures', prevTermId], queryFn: () => api.get<unknown>('/fee-structures', { query: { termId: prevTermId } }).then(listOf<FeeStructure>), enabled: Boolean(prevTermId) });
  const current = structures.data?.find((s) => s.levelId === lid);
  const prevStructure = prev.data?.find((s) => s.levelId === lid);
  const create = useMutation({
    mutationFn: (copy: boolean) => api.post('/fee-structures', { body: { termId: tid, levelId: lid, ...(copy && prevStructure ? { copyFromId: prevStructure.id } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fee-structures'] }),
  });

  return (
    <>
      <PageHeader title="Fee setup" subtitle="Set the fees for each term before invoices go out. Compulsory fees go on every invoice. Optional fees, such as transport or lunch, are only charged when picked." />
      <Group gap="xs" mb="sm" wrap="wrap" role="group" aria-label="Term">
        {yearTerms.map((t) => (
          <Chip key={t.id} selected={t.id === tid} onClick={() => setTermId(t.id)}>
            {t.name.replace(/^.*(Term \d)$/, '$1')}
          </Chip>
        ))}
      </Group>
      <Select label="Level" data={(levels.data ?? []).map((l) => ({ value: l.id, label: l.name }))} value={lid} onChange={setLevelId} allowDeselect={false} maw={260} mb="md" />
      <QueryState query={structures}>
        {() =>
          current && items.data ? (
            <Loader fs={current} items={items.data} />
          ) : (
            <Stack maw={640}>
              <Message kind="warning">No fees are set for this level and term yet.</Message>
              <Can perm="fee_structures:create">
                <Group>
                  <Button onClick={() => create.mutate(false)} loading={create.isPending && create.variables === false}>
                    Start a fee setup
                  </Button>
                  {prevStructure && (
                    <Button variant="default" onClick={() => create.mutate(true)} loading={create.isPending && create.variables === true}>
                      Copy fees from previous term
                    </Button>
                  )}
                </Group>
                <ProblemAlert error={create.error} />
              </Can>
            </Stack>
          )
        }
      </QueryState>
    </>
  );
}
