import { zodResolver } from '@hookform/resolvers/zod';
import { Anchor, Button, FileInput, Group, Select, SimpleGrid, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { formatCedis } from '@sms/shared';
import { listOf, normGuardianLinks } from '@/api/normalise';
import { api, ApiError, NetworkError, upload } from '@/api/client';
import type { Invoice, Page, Payment, PaymentDuplicateMatch, PaymentMethod, RecordPaymentRequest } from '@/api/types';
import { ProblemAlert } from '@/components/ProblemAlert';
import { StudentPicker } from '@/components/StudentPicker';
import { Message, Money, Section } from '@/components/ui';
import { dateToInstant, formatDate, money, PAYMENT_METHOD_LABELS, todayInAccra, tryParseCedis } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

const schema = z
  .object({
    studentId: z.string({ message: 'Choose the student' }).min(1, 'Choose the student'),
    amount: z.string().refine((v) => (tryParseCedis(v) ?? 0) > 0, 'Enter the total received in cedis, e.g. 250 or 250.50'),
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
    if (!v.payer || (v.payer === 'other' && !v.payerName)) ctx.addIssue({ code: 'custom', path: [v.payer === 'other' ? 'payerName' : 'payer'], message: 'Say who paid (choose a parent or type a name)' });
    if (v.method !== 'cash' && !v.referenceNo) ctx.addIssue({ code: 'custom', path: ['referenceNo'], message: 'Enter the reference number (needed for everything except cash)' });
  });
type Values = z.infer<typeof schema>;

type Outcome = { kind: 'idle' } | { kind: 'unsure'; body: RecordPaymentRequest } | { kind: 'duplicate'; error: ApiError; body: RecordPaymentRequest };

export interface FeeLine {
  id: string;
  label: string;
  detail: string;
  fee: number;
  paid: number;
  outstanding: number;
}

/** Split a total across the chosen lines in order, never more than each balance; the rest is credit. */
export function autoAllocate<T extends { id: string; outstanding: number }>(lines: T[], amount: number) {
  let left = amount;
  const out = lines.map((l) => {
    const take = Math.max(0, Math.min(l.outstanding, left));
    left -= take;
    return { ...l, amount: take };
  });
  return { lines: out, credit: Math.max(0, left) };
}

const plain = (p: number) => formatCedis(p, { symbol: false }).replace(/,/g, '');

export function PaymentForm({ initialStudentId, onSaved }: { initialStudentId?: string; onSaved: (p: Payment) => void }) {
  const qc = useQueryClient();
  // One key per form opening; reused for every retry while the outcome is unknown.
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey('pay'));
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [overrideReason, setOverrideReason] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [paying, setPaying] = useState<Record<string, string>>({});
  const [splitFromTotal, setSplitFromTotal] = useState(false);
  const [evidence, setEvidence] = useState<File | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { studentId: initialStudentId ?? '', amount: '', method: 'cash', referenceNo: '', date: todayInAccra(), payer: '', payerName: '', notes: '' },
  });
  const { register, control, watch, formState, setValue } = form;
  const errors = formState.errors;
  const [studentId, method, amountText, reference] = watch(['studentId', 'method', 'amount', 'referenceNo']);
  const total = tryParseCedis(amountText ?? '') ?? 0;
  const locked = outcome.kind === 'unsure';

  // ----- as-you-type duplicate check -----
  const [debouncedRef] = useDebouncedValue((reference ?? '').trim(), 400);
  const dupCheck = useQuery({
    queryKey: ['payment-dup', method, debouncedRef],
    queryFn: ({ signal }) => api.get<unknown>('/payments/duplicate-check', { query: { method, referenceNo: debouncedRef }, signal }).then(listOf<PaymentDuplicateMatch>),
    enabled: method !== 'cash' && debouncedRef.length >= 4,
    staleTime: 5_000,
  });
  const dupMatches = method !== 'cash' && debouncedRef.length >= 4 ? (dupCheck.data ?? []) : [];

  // ----- student context -----
  const student = useQuery({ queryKey: ['student', studentId], queryFn: () => api.get<{ fullName?: string; studentCode?: string; className?: string }>('/students/{id}', { path: { id: studentId } }), enabled: Boolean(studentId) });
  const guardians = useQuery({
    queryKey: ['student', studentId, 'guardians'],
    queryFn: () => api.get<unknown>('/students/{id}/guardians', { path: { id: studentId } }).then(normGuardianLinks),
    enabled: Boolean(studentId),
  });
  useEffect(() => {
    if (!form.getValues('payer') && guardians.data?.length) {
      const g = guardians.data.find((x) => x.isFeePayer) ?? guardians.data.find((x) => x.isPrimary) ?? guardians.data[0]!;
      setValue('payer', g.guardian.id!);
    }
  }, [guardians.data, form, setValue]);
  const invoices = useQuery({
    queryKey: ['invoices', { studentId }],
    queryFn: async () => {
      const list = await api.get<unknown>('/invoices', { query: { studentId, pageSize: 50 } }).then(listOf<Invoice>);
      // The list may come without lines; fetch details for invoices that still have something owing.
      return Promise.all(list.map((i) => (i.lines || i.status !== 'issued' || (i.totalPesewas ?? 0) <= (i.paidPesewas ?? 0) ? i : api.get<Invoice>('/invoices/{id}', { path: { id: i.id! } }))));
    },
    enabled: Boolean(studentId),
  });
  const lines: FeeLine[] = useMemo(
    () =>
      (invoices.data ?? [])
        .filter((i) => i.status === 'issued')
        .flatMap((i) =>
          (i.lines ?? []).map((l) => {
            const fee = l.amountPesewas ?? 0;
            const paid = l.paidPesewas ?? 0;
            return { id: l.id!, label: l.feeItemName ?? 'Fee', detail: i.termName || i.invoiceNo || '', fee, paid, outstanding: Math.max(0, fee - paid) };
          }),
        ),
    [invoices.data],
  );
  const chosen = lines.filter((l) => selected.includes(l.id));
  const amounts = Object.fromEntries(chosen.map((l) => [l.id, tryParseCedis(paying[l.id] ?? '') ?? 0]));
  const allocated = Object.values(amounts).reduce((a, b) => a + b, 0);
  const selectedBalance = chosen.reduce((a, l) => a + l.outstanding, 0);
  const credit = Math.max(0, total - allocated);
  const overLine = chosen.find((l) => (amounts[l.id] ?? 0) > l.outstanding);

  // ----- linking "Paying now" amounts and the total -----
  const resplit = (ids: string[], totalPesewas: number) => {
    const split = autoAllocate(lines.filter((l) => ids.includes(l.id)), totalPesewas);
    setPaying(Object.fromEntries(split.lines.map((l) => [l.id, l.amount ? plain(l.amount) : ''])));
  };
  const syncTotal = (next: Record<string, string>, ids: string[]) => {
    const sum = ids.reduce((a, id) => a + (tryParseCedis(next[id] ?? '') ?? 0), 0);
    setValue('amount', sum ? plain(sum) : '', { shouldValidate: formState.isSubmitted });
  };
  const toggleLine = (l: FeeLine, on: boolean) => {
    const ids = on ? [...selected, l.id] : selected.filter((x) => x !== l.id);
    setSelected(ids);
    if (splitFromTotal && total > 0) resplit(ids, total);
    else {
      const next = { ...paying };
      if (on) next[l.id] = l.outstanding ? plain(l.outstanding) : '';
      else delete next[l.id];
      setPaying(next);
      syncTotal(next, ids);
    }
  };
  const editPaying = (id: string, v: string) => {
    setSplitFromTotal(false);
    const next = { ...paying, [id]: v };
    setPaying(next);
    syncTotal(next, selected);
  };
  const editTotal = (v: string) => {
    setValue('amount', v, { shouldValidate: formState.isSubmitted });
    setSplitFromTotal(true);
    const t = tryParseCedis(v);
    if (t !== null && selected.length) resplit(selected, t);
  };
  const payFull = () => {
    setSplitFromTotal(false);
    const next = Object.fromEntries(chosen.map((l) => [l.id, l.outstanding ? plain(l.outstanding) : '']));
    setPaying(next);
    syncTotal(next, selected);
  };

  const buildBody = (v: Values): RecordPaymentRequest => {
    const g = guardians.data?.find((x) => x.guardian.id === v.payer);
    const allocations = chosen.map((l) => ({ invoiceLineId: l.id, amountPesewas: amounts[l.id] ?? 0 })).filter((a) => a.amountPesewas > 0);
    return {
      studentId: v.studentId,
      amountPesewas: tryParseCedis(v.amount)!,
      method: v.method as PaymentMethod,
      referenceNo: v.referenceNo?.trim() || undefined,
      receivedAt: dateToInstant(v.date),
      payerGuardianId: g?.guardian.id,
      payerName: g ? g.guardian.fullName : v.payerName?.trim() || undefined,
      notes: v.notes?.trim() || undefined,
      // Explicit allocations from the toggled fees; anything left over becomes credit. None chosen = school's automatic order.
      allocations: allocations.length ? allocations : undefined,
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
      void qc.invalidateQueries({ queryKey: ['invoices'] });
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
    if (overLine) return;
    if (allocated > (tryParseCedis(v.amount) ?? 0)) {
      form.setError('amount', { message: 'The fees chosen add up to more than the total received' });
      return;
    }
    save.mutate({ body: buildBody(v), key: idemKey });
  });

  const generalError = save.error && !(save.error instanceof NetworkError) && !(save.error instanceof ApiError && (save.error.code === 'PAYMENT_DUPLICATE_REFERENCE' || save.error.status >= 500)) ? save.error : null;
  const s = student.data;

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Record a payment">
      <Stack gap="md">
        {s && (
          <Text c="dimmed" size="sm" mt={-12}>
            {s.fullName} · {s.studentCode} · {s.className ?? 'No class'}
          </Text>
        )}
        {(!initialStudentId || !studentId) && (
          <Section>
            <Controller control={control} name="studentId" render={({ field }) => <StudentPicker required value={field.value || null} onChange={(id) => { field.onChange(id ?? ''); setSelected([]); setPaying({}); }} error={errors.studentId?.message} disabled={locked} />} />
          </Section>
        )}

        {studentId && (
          <Section title="What is this payment for?">
            {invoices.isLoading ? (
              <Text size="sm">Loading bills…</Text>
            ) : lines.length === 0 ? (
              <Text size="sm" c="dimmed">
                No bills for this student. The whole amount will be kept as credit.
              </Text>
            ) : (
              <>
                {lines.map((l) => {
                  const on = selected.includes(l.id);
                  return (
                    <Group key={l.id} justify="space-between" wrap="nowrap" gap="sm" py="sm" align="flex-start" style={{ borderTop: '1px solid var(--k-line)' }}>
                      <div style={{ flex: '1 1 0', minWidth: 0 }}>
                        <Text size="sm" fw={500}>
                          {l.label}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {l.detail ? `${l.detail} · ` : ''}fee {money(l.fee)} · Paid {money(l.paid)} · Balance {money(l.outstanding)}
                        </Text>
                        {on && (
                          <TextInput
                            label="Paying now (GH₵)"
                            size="sm"
                            mt={6}
                            maw={160}
                            inputMode="decimal"
                            value={paying[l.id] ?? ''}
                            onChange={(e) => editPaying(l.id, e.currentTarget.value)}
                            disabled={locked}
                            error={(paying[l.id] ?? '') !== '' && tryParseCedis(paying[l.id]!) === null ? 'Not an amount' : (amounts[l.id] ?? 0) > l.outstanding ? 'More than the balance' : undefined}
                          />
                        )}
                      </div>
                      <Switch size="lg" mt={4} aria-label={`Pay ${l.label}${l.detail ? ` (${l.detail})` : ''}`} checked={on} onChange={(e) => toggleLine(l, e.currentTarget.checked)} disabled={locked || (l.outstanding === 0 && !on)} />
                    </Group>
                  );
                })}
                <Group justify="space-between" pt="sm" style={{ borderTop: '2px solid var(--k-ink)' }} wrap="wrap">
                  <Text fw={600}>Balance on selected fees {money(selectedBalance)}</Text>
                  <Button variant="default" onClick={payFull} disabled={locked || chosen.length === 0}>
                    Pay full balances
                  </Button>
                </Group>
              </>
            )}
          </Section>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <Section>
            <Stack gap="sm">
              <Controller
                control={control}
                name="method"
                render={({ field }) => (
                  <Select label="Method" withAsterisk size="md" data={Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))} value={field.value} onChange={(x) => field.onChange(x ?? 'cash')} allowDeselect={false} disabled={locked} />
                )}
              />
              <TextInput
                label="Reference number"
                description={method === 'cash' ? 'Optional for cash' : method === 'cheque' ? 'Cheque number' : method === 'bank_transfer' ? 'Bank slip or transfer reference' : 'Mobile money transaction ID'}
                withAsterisk={method !== 'cash'}
                size="md"
                {...register('referenceNo')}
                error={errors.referenceNo?.message}
                disabled={locked}
                autoComplete="off"
              />
              {dupMatches.length > 0 && outcome.kind !== 'duplicate' && (
                <Message kind="warning">
                  {dupMatches.map((d) => (
                    <div key={d.paymentId}>
                      A payment with reference {debouncedRef} was recorded on {formatDate(d.receivedAt)} for {d.studentName} (receipt{' '}
                      <Anchor component={Link} to={`/finance/payments/${d.paymentId}`} target="_blank" inherit>
                        {d.receiptNo}
                      </Anchor>
                      , {money(d.amountPesewas)}).
                    </div>
                  ))}
                  Check this is not a repeat.
                </Message>
              )}
              <TextInput
                label="Total received (GH₵)"
                description="Type a total to split it across the selected fees"
                withAsterisk
                size="md"
                inputMode="decimal"
                placeholder="e.g. 1200"
                value={amountText}
                onChange={(e) => editTotal(e.currentTarget.value)}
                onBlur={() => void form.trigger('amount')}
                error={errors.amount?.message}
                disabled={locked}
              />
              <Controller
                control={control}
                name="payer"
                render={({ field }) => (
                  <Select
                    label="Paid by"
                    withAsterisk
                    error={errors.payer?.message}
                    placeholder="Choose a parent or someone else"
                    data={[...(guardians.data ?? []).map((g) => ({ value: g.guardian.id!, label: `${g.guardian.fullName} (${g.relationship})` })), { value: 'other', label: 'Someone else' }]}
                    value={field.value || null}
                    onChange={(x) => field.onChange(x ?? '')}
                    disabled={locked || !studentId}
                  />
                )}
              />
              {watch('payer') === 'other' && <TextInput label="Payer's name" withAsterisk {...register('payerName')} error={errors.payerName?.message} disabled={locked} />}
              <SimpleGrid cols={2}>
                <TextInput label="Date received" type="date" withAsterisk max={todayInAccra()} {...register('date')} error={errors.date?.message} disabled={locked} />
                <FileInput label="Evidence (optional)" placeholder="Photo or PDF" accept="image/png,image/jpeg,application/pdf" value={evidence} onChange={setEvidence} clearable disabled={locked} />
              </SimpleGrid>
              <Textarea label="Notes (optional)" {...register('notes')} autosize minRows={1} disabled={locked} />

              {outcome.kind === 'duplicate' && (
                <Message kind="warning">
                  <Text fw={600} size="sm">
                    {outcome.error.problem.title}
                  </Text>
                  <Text size="sm">{outcome.error.problem.detail}</Text>
                  <Text size="sm" mt={4}>
                    If this really is a different payment (for example the parent paid twice), give the reason and save again. Otherwise cancel.
                  </Text>
                  <Textarea mt="xs" label="Why is this a separate payment?" value={overrideReason} onChange={(e) => setOverrideReason(e.currentTarget.value)} />
                  <Group mt="xs">
                    <Button disabled={overrideReason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate({ body: { ...outcome.body, confirmDuplicate: true, duplicateOverrideReason: overrideReason.trim() }, key: idemKey })}>
                      Save anyway
                    </Button>
                    <Button variant="default" onClick={() => setOutcome({ kind: 'idle' })}>
                      Cancel
                    </Button>
                  </Group>
                </Message>
              )}

              {outcome.kind === 'unsure' && (
                <Message kind="warning">
                  <Text fw={700}>Not sure it saved — check before trying again</Text>
                  <Text size="sm">The connection dropped before the server answered. The payment may or may not have been recorded. Do not write a receipt by hand.</Text>
                  <Group mt="sm" wrap="wrap">
                    <Button onClick={() => lookup.mutate()} loading={lookup.isPending}>
                      Check if it was saved
                    </Button>
                    {lookup.isSuccess && lookup.data === null && (
                      <Button variant="default" onClick={() => save.mutate({ body: outcome.body, key: idemKey })} loading={save.isPending}>
                        Not found — send it again (safe)
                      </Button>
                    )}
                  </Group>
                  {lookup.isSuccess && lookup.data === null && <Text size="sm" mt="xs">It was not found on the server. Sending again uses the same safety key, so it cannot be recorded twice.</Text>}
                  {lookup.error && <Text size="sm" mt="xs">Still cannot reach the server. Wait for the connection, then check again.</Text>}
                </Message>
              )}

              <ProblemAlert error={generalError} />
              {outcome.kind === 'idle' && (
                <>
                  <Button type="submit" size="md" fullWidth loading={save.isPending}>
                    Save payment
                  </Button>
                  <Text size="xs" c="dimmed">
                    A receipt number is given only when the server confirms.
                  </Text>
                </>
              )}
            </Stack>
          </Section>

          <Section title="Allocation to invoice items">
            {chosen.length === 0 ? (
              <Text size="sm" c="dimmed">
                No fee chosen. The payment will be applied automatically, oldest bill first.
              </Text>
            ) : (
              chosen.map((l) => {
                const a = amounts[l.id] ?? 0;
                const left = l.outstanding - a;
                return (
                  <Group key={l.id} justify="space-between" py={8} style={{ borderTop: '1px solid var(--k-line)' }} wrap="nowrap" align="flex-start">
                    <Text size="sm">
                      {l.label}{' '}
                      {l.detail && (
                        <Text span c="dimmed" size="sm">
                          ({l.detail})
                        </Text>
                      )}
                    </Text>
                    <Text size="sm" ta="right">
                      {money(a)} {a > 0 && (left > 0 ? `(part payment, ${money(left)} left)` : '(cleared)')}
                    </Text>
                  </Group>
                );
              })
            )}
            {credit > 0 && (
              <Group justify="space-between" py={8} style={{ borderTop: '1px solid var(--k-line)' }}>
                <Text size="sm">Kept as credit</Text>
                <Text size="sm">{money(credit)}</Text>
              </Group>
            )}
            <Group justify="space-between" pt="sm" mt={4} style={{ borderTop: '2px solid var(--k-ink)' }}>
              <Text fw={600} size="sm">
                Balance left on selected fees
              </Text>
              <Text fw={700} size="sm">
                <Money value={Math.max(0, selectedBalance - allocated)} />
              </Text>
            </Group>
          </Section>
        </SimpleGrid>
      </Stack>
    </form>
  );
}
