import { Alert, Button, Card, Group, MultiSelect, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/api/client';
import { classOptions, useClasses, useCurrentTerm, useLevels } from '@/api/queries';
import type { InvoicePreview } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';
import { Money, PageHeader } from '@/components/ui';
import { money } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

/** Generate term invoices: always a dry-run preview first, then confirm. */
export default function InvoicesPage() {
  const { terms, term } = useCurrentTerm();
  const classes = useClasses();
  const levels = useLevels();
  const [termId, setTermId] = useState<string | null>(null);
  const [scope, setScope] = useState<'school' | 'level' | 'class'>('school');
  const [ids, setIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [key, setKey] = useState(() => newIdempotencyKey('inv'));
  const [done, setDone] = useState<InvoicePreview | null>(null);
  const tid = termId ?? term?.id ?? null;
  const body = (dryRun: boolean) => ({ termId: tid, scope: { type: scope, ids: scope === 'school' ? [] : ids }, dueDate: dueDate || undefined, dryRun });

  const preview = useMutation({ mutationFn: () => api.post<InvoicePreview>('/invoices/generate', { body: body(true), idempotencyKey: newIdempotencyKey('inv-dry') }) });
  const generate = useMutation({
    mutationFn: () => api.post<InvoicePreview>('/invoices/generate', { body: body(false), idempotencyKey: key }),
    onSuccess: (r) => {
      setDone(r);
      preview.reset();
      setKey(newIdempotencyKey('inv'));
    },
  });

  return (
    <>
      <PageHeader title="Generate invoices" subtitle="Bills each student for the term from the active fee structure. Students already billed are skipped." />
      <Can perm="invoices:create" fallback={<Text>You can view invoices on each student's Fees tab.</Text>}>
        <Card withBorder maw={760}>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select label="Term" data={terms.map((t) => ({ value: t.id, label: t.name }))} value={tid} onChange={(v) => { setTermId(v); preview.reset(); }} />
              <TextInput type="date" label="Due date (optional)" value={dueDate} onChange={(e) => setDueDate(e.currentTarget.value)} />
            </SimpleGrid>
            <SegmentedControl value={scope} onChange={(v) => { setScope(v as typeof scope); setIds([]); preview.reset(); }} data={[{ value: 'school', label: 'Whole school' }, { value: 'level', label: 'Some levels' }, { value: 'class', label: 'Some classes' }]} />
            {scope !== 'school' && (
              <MultiSelect
                label={scope === 'level' ? 'Levels' : 'Classes'}
                data={scope === 'level' ? (levels.data ?? []).map((l) => ({ value: l.id, label: l.name })) : classOptions(classes.data)}
                value={ids}
                onChange={(v) => { setIds(v); preview.reset(); }}
              />
            )}
            <Group>
              <Button onClick={() => { setDone(null); preview.mutate(); }} loading={preview.isPending} disabled={!tid || (scope !== 'school' && ids.length === 0)}>
                Preview (nothing is saved)
              </Button>
            </Group>
            <ProblemAlert error={preview.error ?? generate.error} />
          </Stack>
        </Card>
        {preview.data && (
          <Card withBorder maw={760} mt="md">
            <Title order={2} size="h4">
              Preview
            </Title>
            <Group gap="xl" my="sm">
              <Text>
                <b>{preview.data.studentCount}</b> invoices
              </Text>
              <Text>
                Total <b><Money value={preview.data.totalPesewas} /></b>
              </Text>
              <Text>{preview.data.skippedAlreadyInvoiced} already billed (skipped)</Text>
            </Group>
            {preview.data.problems.length > 0 && (
              <Alert color="orange" title={`${preview.data.problems.length} student(s) cannot be billed`} mb="sm">
                {preview.data.problems.slice(0, 10).map((p, i) => (
                  <Text size="sm" key={i}>
                    {p.studentName}: {p.message}
                  </Text>
                ))}
              </Alert>
            )}
            <div className="table-scroll">
              <Table fz="sm" miw={480}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Student</Table.Th>
                    <Table.Th>Class</Table.Th>
                    <Table.Th ta="right">This term</Table.Th>
                    <Table.Th ta="right">Brought forward</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.data.sample.map((s, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>{s.studentName}</Table.Td>
                      <Table.Td>{s.className}</Table.Td>
                      <Table.Td ta="right"><Money value={s.totalPesewas} /></Table.Td>
                      <Table.Td ta="right"><Money value={s.broughtForwardPesewas} owes /></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <Text size="xs" c="dimmed">Showing the first {preview.data.sample.length}. Brought-forward balances are shown on the invoice, not charged again.</Text>
            <Button
              mt="md"
              disabled={preview.data.studentCount === 0}
              loading={generate.isPending}
              onClick={() =>
                modals.openConfirmModal({
                  title: `Create ${preview.data!.studentCount} invoices?`,
                  children: <Text size="sm">This bills {preview.data!.studentCount} students a total of {money(preview.data!.totalPesewas)}. To undo, each invoice must be voided with a reason.</Text>,
                  labels: { confirm: 'Create invoices', cancel: 'Cancel' },
                  onConfirm: () => generate.mutate(),
                })
              }
            >
              Create {preview.data.studentCount} invoices
            </Button>
          </Card>
        )}
        {done && (
          <Alert color="green" title="Invoices created" mt="md" maw={760}>
            {done.studentCount} invoices were created (total {money(done.totalPesewas)}).
          </Alert>
        )}
      </Can>
    </>
  );
}
