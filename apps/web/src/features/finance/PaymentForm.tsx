import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Anchor, Button, Card, FileInput, Group, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { api, ApiError, NetworkError, upload } from '@/api/client';
import type { Invoice, ListResponse, Page, Payment, PaymentDuplicateMatch, PaymentMethod, RecordPaymentRequest, StudentGuardianLink } from '@/api/types';
import { ProblemAlert } from '@/components/ProblemAlert';
import { StudentPicker } from '@/components/StudentPicker';
import { Money } from '@/components/ui';
import { dateToInstant, formatDate, money, PAYMENT_METHOD_LABELS, todayInAccra, tryParseCedis } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

const schema = z
  .object({
    studentId: z.string({ message: 'Choose the student' }).min(1, 'Choose the student'),
    amount: z.string().refine((v) => (tryParseCedis(v) ?? 0) > 0, 'Enter an amount in cedis, e.g. 250 or 250.50'),
    method: z.enum(['cash', 'bank_transfer', 'cheque', 'momo_mtn', 'telecel_cash', 'at_money']),
    referenceNo: z.string().trim().max(64).optional(),
    date: z
      .string()
      .min(1, 'Enter the date received')
      .refine((d) => d <= todayInAccra(), 'The date cannot be in the future'),
    payer: z.string().optional(),
    payerName: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method !== 'cash' && !v.referenceNo) ctx.addIssue({ code: 'custom', path: ['referenceNo'], message: 'Enter the reference number (needed for everything except cash)' });
  });
type Values = z.infer<typeof schema>;

type Outcome =
  | { kind: 'idle' }
  | { kind: 'unsure'; body: RecordPaymentRequest }
  | { kind: 'duplicate'; error: ApiError; body: RecordPaymentRequest };

interface OpenLine {
  id: string;
  label: string;
  outstanding: number;
}

/** Automatic allocation preview: oldest invoice first, lines in order (server decides finally). */
export function autoAllocate(lines: OpenLine[], amount: number) {
  let left = amount;
  const out = lines.map((l) => {
    const take = Math.max(0, Math.min(l.outstanding, left));
    left -= take;
    return { ...l, amount: take };
  });
  return { lines: out, credit: Math.max(0, left) };
}

export function PaymentForm({ initialStudentId, onSaved }: { initialStudentId?: string; onSaved: (p: Payment) => void }) {
  const qc = useQueryClient();
  // One key per form opening; reused for every retry while the outcome is unknown.
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey('pay'));
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [overrideReason, setOverrideReason] = useState('');
  const [allocMode, setAllocMode] = useState<'auto' | 'manual'>('auto');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<File | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { studentId: initialStudentId ?? '', amount: '', method: 'cash', referenceNo: '', date: todayInAccra(), payer: '', payerName: '', notes: '' },
  });
  const { register, control, watch, formState } = form;
  const errors = formState.errors;
  const [studentId, method, amountText, reference] = watch(['studentId', 'method', 'amount', 'referenceNo']);
  const amount = tryParseCedis(amountText ?? '') ?? 0;
  const locked = outcome.kind === 'unsure';

  // ----- as-you-type duplicate check -----
  const [debouncedRef] = useDebouncedValue((reference ?? '').trim(), 400);
  const dupCheck = useQuery({
    queryKey: ['payment-dup', method, debouncedRef],
    queryFn: ({ signal }) => api.get<ListResponse<PaymentDuplicateMatch>>('/payments/duplicate-check', { query: { method, referenceNo: debouncedRef }, signal }).then((r) => r.data),
    enabled: method !== 'cash' && debouncedRef.length >= 4,
    staleTime: 5_000,
  });
  const dupMatches = method !== 'cash' && debouncedRef.length >= 4 ? (dupCheck.data ?? []) : [];

  // ----- student context: guardians (payer) and open invoice lines -----
  const guardians = useQuery({
    queryKey: ['student', studentId, 'guardians'],
    queryFn: () => api.get<ListResponse<StudentGuardianLink>>('/students/{id}/guardians', { path: { id: studentId } }).then((r) => r.data),
    enabled: Boolean(studentId),
  });
  const invoices = useQuery({
    queryKey: ['invoices', { studentId }],
    queryFn: () => api.get<Page<Invoice>>('/invoices', { query: { studentId, pageSize: 50 } }).then((r) => r.data),
    enabled: Boolean(studentId),
  });
  const openLines: OpenLine[] = useMemo(
    () =>
      (invoices.data ?? [])
        .filter((i) => i.status === 'issued')
        .flatMap((i) => (i.lines ?? []).map((l) => ({ id: l.id!, label: `${i.invoiceNo} · ${l.feeItemName}`, outstanding: (l.amountPesewas ?? 0) - (l.paidPesewas ?? 0) })))
        .filter((l) => l.outstanding > 0),
    [invoices.data],
  );
  const auto = autoAllocate(openLines, amount);
  const manualTotal = Object.values(manual).reduce<number>((a, v) => a + (tryParseCedis(v) ?? 0), 0);

  const buildBody = (v: Values): RecordPaymentRequest => {
    const g = guardians.data?.find((x) => x.guardian.id === v.payer);
    return {
      studentId: v.studentId,
      amountPesewas: tryParseCedis(v.amount)!,
      method: v.method as PaymentMethod,
      referenceNo: v.referenceNo?.trim() || undefined,
      receivedAt: dateToInstant(v.date),
      payerGuardianId: g?.guardian.id,
      payerName: g ? g.guardian.fullName : v.payerName?.trim() || undefined,
      notes: v.notes?.trim() || undefined,
      allocations:
        allocMode === 'manual'
          ? Object.entries(manual)
              .map(([invoiceLineId, x]) => ({ invoiceLineId, amountPesewas: tryParseCedis(x) ?? 0 }))
              .filter((a) => a.amountPesewas > 0)
          : undefined,
    };
  };

  const save = useMutation({
    mutationFn: ({ body, key }: { body: RecordPaymentRequest; key: string }) => api.post<Payment>('/payments', { body, idempotencyKey: key }),
    onSuccess: async (p) => {
      if (evidence) {
        try {
          const fd = new FormData();
          fd.append('file', evidence);
          await upload('PUT', '/payments/{id}/attachment', { id: p.id! }, fd);
        } catch {
          // The payment itself is saved; the receipt page offers to attach the evidence again.
        }
      }
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['ledger', p.studentId] });
      void qc.invalidateQueries({ queryKey: ['balance', p.studentId] });
      setOutcome({ kind: 'idle' });
      onSaved(p);
    },
    onError: (e, vars) => {
      if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
        // We do not know whether the server saved it. Keep the same key and body for a safe retry.
        setOutcome({ kind: 'unsure', body: vars.body });
        return;
      }
      // Definitely not saved: the next attempt is a new request with a new key.
      setIdemKey(newIdempotencyKey('pay'));
      if (e instanceof ApiError && e.code === 'PAYMENT_DUPLICATE_REFERENCE') setOutcome({ kind: 'duplicate', error: e, body: vars.body });
      else if (e instanceof ApiError) for (const [field, message] of Object.entries(e.fieldErrors())) if (field in form.getValues()) form.setError(field as keyof Values, { message });
    },
  });

  const lookup = useMutation({
    mutationFn: () => api.get<Page<Payment>>('/payments', { query: { idempotencyKey: idemKey } }).then((r) => r.data[0] ?? null),
    onSuccess: (found) => {
      if (found) {
        setOutcome({ kind: 'idle' });
        onSaved(found);
      }
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    if (allocMode === 'manual' && manualTotal > (tryParseCedis(v.amount) ?? 0)) {
      form.setError('amount', { message: 'The allocations add up to more than the amount paid' });
      return;
    }
    save.mutate({ body: buildBody(v), key: idemKey });
  });

  const generalError = save.error && !(save.error instanceof NetworkError) && !(save.error instanceof ApiError && (save.error.code === 'PAYMENT_DUPLICATE_REFERENCE' || save.error.status >= 500)) ? save.error : null;

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Record a payment">
      <Stack>
        <Card withBorder>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Controller control={control} name="studentId" render={({ field }) => <StudentPicker required value={field.value || null} onChange={(id) => field.onChange(id ?? '')} error={errors.studentId?.message} disabled={locked} />} />
            <TextInput label="Amount received (GH₵)" withAsterisk inputMode="decimal" placeholder="e.g. 250.00" {...register('amount')} error={errors.amount?.message} disabled={locked} description={amount > 0 ? `= ${money(amount)}` : undefined} />
            <Controller
              control={control}
              name="method"
              render={({ field }) => (
                <Select label="How was it paid?" withAsterisk data={Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))} value={field.value} onChange={(x) => field.onChange(x ?? 'cash')} allowDeselect={false} disabled={locked} />
              )}
            />
            <TextInput
              label={method === 'cash' ? 'Reference (optional for cash)' : method.startsWith('momo') || method.endsWith('cash') || method === 'at_money' ? 'Transaction ID' : method === 'cheque' ? 'Cheque number' : 'Bank reference'}
              withAsterisk={method !== 'cash'}
              {...register('referenceNo')}
              error={errors.referenceNo?.message}
              disabled={locked}
              autoComplete="off"
            />
            <TextInput label="Date received" type="date" withAsterisk max={todayInAccra()} {...register('date')} error={errors.date?.message} disabled={locked} />
            <Controller
              control={control}
              name="payer"
              render={({ field }) => (
                <Select
                  label="Paid by"
                  placeholder="Choose a parent or type a name below"
                  data={[...(guardians.data ?? []).map((g) => ({ value: g.guardian.id!, label: `${g.guardian.fullName} (${g.relationship})` })), { value: 'other', label: 'Someone else' }]}
                  value={field.value || null}
                  onChange={(x) => field.onChange(x ?? '')}
                  clearable
                  disabled={locked || !studentId}
                />
              )}
            />
            {watch('payer') === 'other' && <TextInput label="Payer's name" {...register('payerName')} disabled={locked} />}
            <Textarea label="Notes (optional)" {...register('notes')} autosize minRows={1} disabled={locked} />
            <FileInput label="Evidence (optional)" description="MoMo screenshot or bank slip: image or PDF, up to 5 MB" accept="image/png,image/jpeg,application/pdf" value={evidence} onChange={setEvidence} clearable disabled={locked} />
          </SimpleGrid>
        </Card>

        {dupMatches.length > 0 && outcome.kind !== 'duplicate' && (
          <Alert color="yellow" title="This reference number was already used" role="alert">
            {dupMatches.map((d) => (
              <Text size="sm" key={d.paymentId}>
                Receipt{' '}
                <Anchor component={Link} to={`/finance/payments/${d.paymentId}`} target="_blank">
                  {d.receiptNo}
                </Anchor>{' '}
                — {d.studentName} — {money(d.amountPesewas)} on {formatDate(d.receivedAt)}
              </Text>
            ))}
            <Text size="sm" mt={4}>
              Check that this is not the same payment being entered twice.
            </Text>
          </Alert>
        )}

        {studentId && (
          <Card withBorder>
            <Group justify="space-between" mb="xs" wrap="wrap">
              <Title order={2} size="h5">
                What does this payment cover?
              </Title>
              <SegmentedControl size="xs" value={allocMode} onChange={(v) => setAllocMode(v as 'auto' | 'manual')} data={[{ value: 'auto', label: 'Automatic (oldest first)' }, { value: 'manual', label: 'Choose myself' }]} disabled={locked} />
            </Group>
            {invoices.isLoading ? (
              <Text size="sm">Loading bills…</Text>
            ) : openLines.length === 0 ? (
              <Text size="sm" c="dimmed">
                Nothing outstanding. The whole amount will be kept as credit.
              </Text>
            ) : (
              <div className="table-scroll">
                <Table fz="sm" miw={420}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Bill item</Table.Th>
                      <Table.Th ta="right">Still owed</Table.Th>
                      <Table.Th ta="right">This payment</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {auto.lines.map((l) => (
                      <Table.Tr key={l.id}>
                        <Table.Td>{l.label}</Table.Td>
                        <Table.Td ta="right">
                          <Money value={l.outstanding} />
                        </Table.Td>
                        <Table.Td ta="right">
                          {allocMode === 'auto' ? (
                            <Money value={l.amount} />
                          ) : (
                            <TextInput aria-label={`Amount for ${l.label}`} size="xs" w={110} ml="auto" inputMode="decimal" value={manual[l.id] ?? ''} onChange={(e) => { const x = e.currentTarget.value; setManual((m) => ({ ...m, [l.id]: x })); }} error={(manual[l.id] ?? '') !== '' && tryParseCedis(manual[l.id]!) === null ? 'Not a valid amount' : (tryParseCedis(manual[l.id] ?? '') ?? 0) > l.outstanding ? 'More than owed' : undefined} disabled={locked} />
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
            <Text size="sm" mt="xs">
              {allocMode === 'auto' ? (auto.credit > 0 ? `${money(auto.credit)} will be kept as credit.` : '') : `Allocated ${money(manualTotal)} of ${money(amount)}; any rest is kept as credit.`}
            </Text>
          </Card>
        )}

        {outcome.kind === 'duplicate' && (
          <Alert color="orange" title={outcome.error.problem.title} role="alert">
            <Text size="sm">{outcome.error.problem.detail}</Text>
            <Text size="sm" mt={4}>
              If this really is a different payment (for example the parent paid twice), give the reason and save again. Otherwise cancel.
            </Text>
            <Textarea mt="xs" label="Why is this a separate payment?" value={overrideReason} onChange={(e) => setOverrideReason(e.currentTarget.value)} />
            <Group mt="xs">
              <Button color="orange" disabled={overrideReason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate({ body: { ...outcome.body, confirmDuplicate: true, duplicateOverrideReason: overrideReason.trim() }, key: idemKey })}>
                Save anyway
              </Button>
              <Button variant="default" onClick={() => setOutcome({ kind: 'idle' })}>
                Cancel
              </Button>
            </Group>
          </Alert>
        )}

        {outcome.kind === 'unsure' && (
          <Alert color="orange" variant="filled" title="Not sure it saved — check before trying again" role="alert">
            <Text size="sm">The connection dropped before the server answered. The payment may or may not have been recorded. Do not write a receipt by hand.</Text>
            <Group mt="sm" wrap="wrap">
              <Button color="dark" onClick={() => lookup.mutate()} loading={lookup.isPending}>
                Check if it was saved
              </Button>
              {lookup.isSuccess && lookup.data === null && (
                <Button color="dark" variant="white" onClick={() => save.mutate({ body: outcome.body, key: idemKey })} loading={save.isPending}>
                  Not found — send it again (safe)
                </Button>
              )}
            </Group>
            {lookup.isSuccess && lookup.data === null && (
              <Text size="sm" mt="xs">
                It was not found on the server. Sending again uses the same safety key, so it cannot be recorded twice.
              </Text>
            )}
            {lookup.error && <Text size="sm" mt="xs">Still cannot reach the server. Wait for the connection, then check again.</Text>}
          </Alert>
        )}

        <ProblemAlert error={generalError} />

        {outcome.kind === 'idle' && (
          <Group>
            <Button type="submit" size="md" loading={save.isPending}>
              Save payment
            </Button>
            <Text size="xs" c="dimmed">
              A receipt number is given only when the server confirms.
            </Text>
          </Group>
        )}
      </Stack>
    </form>
  );
}
