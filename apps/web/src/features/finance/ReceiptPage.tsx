import { Alert, Button, Card, Group, Modal, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, downloadFile } from '@/api/client';
import type { Payment } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { Message, Money, PageHeader, QueryState } from '@/components/ui';
import { formatDate, formatDateTime, PAYMENT_METHOD_LABELS } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

type PaymentDetail = Payment & { pendingReversal?: { requestedBy: string; reason: string; at: string } | null; awaitingApproval?: boolean };

export default function ReceiptPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { me } = useAuth();
  const school = useQuery({ queryKey: ['school'], queryFn: () => api.get<{ name?: string }>('/settings/school'), staleTime: 10 * 60_000, retry: false });
  const query = useQuery({ queryKey: ['payment', id], queryFn: () => api.get<PaymentDetail>('/payments/{id}', { path: { id } }) });
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reverseKey, setReverseKey] = useState(() => newIdempotencyKey('rev'));
  const reverse = useMutation({
    mutationFn: () => api.post<PaymentDetail>('/payments/{id}/reverse', { path: { id }, body: { reason }, idempotencyKey: reverseKey }),
    onSuccess: (p) => {
      setReverseOpen(false);
      setReverseKey(newIdempotencyKey('rev'));
      notifications.show({ color: p.status === 'reversed' ? 'green' : 'yellow', message: p.status === 'reversed' ? 'Payment reversed.' : "Today's cash-up is closed, so the reversal is waiting for the administrator to approve." });
      void qc.invalidateQueries({ queryKey: ['payment', id] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
  });
  const approve = useMutation({
    mutationFn: () => api.post('/payments/{id}/reverse/approve', { path: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payment', id] }),
    onError: (e) => notifications.show(notifyError(e)),
  });
  const pdf = useMutation({ mutationFn: () => downloadFile('/payments/{id}/receipt.pdf', { id }), onError: (e) => notifications.show(notifyError(e)) });

  return (
    <QueryState query={query} label="Loading receipt…">
      {(p) => (
        <Stack maw={560}>
          <PageHeader
            title="Receipt"
            actions={
              <Group className="no-print">
                <Button variant="default" onClick={() => pdf.mutate()} loading={pdf.isPending}>
                  PDF receipt
                </Button>
                <Button size="md" onClick={() => window.print()}>
                  Print receipt
                </Button>
              </Group>
            }
          />
          {params.get('new') && (
            <div className="no-print">
              <Message kind="success">Saved. The server confirmed this payment and the receipt is ready to print. Give the receipt number {p.receiptNo} to the payer.</Message>
            </div>
          )}
          {p.pendingReversal && (
            <Message kind="warning">
              <b>Reversal waiting for approval.</b> Requested by {p.pendingReversal.requestedBy}: {p.pendingReversal.reason}
              <Can perm="payments:reverse_approve">
                {p.pendingReversal.requestedBy !== me?.fullName && (
                  <Button mt="xs" size="xs" onClick={() => approve.mutate()} loading={approve.isPending} display="block">
                    Approve reversal
                  </Button>
                )}
              </Can>
            </Message>
          )}
          <Card radius={0} p="xl" style={{ background: '#fff' }} aria-label={`Receipt ${p.receiptNo}`}>
            <Text ta="center" className="k-serif" fz={20} fw={600}>
              {school.data?.name ?? 'Kansview School'}
            </Text>
            <Text ta="center" size="sm" c="dimmed" mb="md">
              Official fee receipt
            </Text>
            {p.status === 'reversed' && (
              <Text ta="center" fw={700} c="var(--k-red)" mb="sm" style={{ letterSpacing: 2 }}>
                REVERSED
              </Text>
            )}
            <Group justify="space-between" mb={8}>
              <Text size="sm">Receipt no. {p.receiptNo}</Text>
              <Text size="sm">{formatDate(p.receivedAt)}</Text>
            </Group>
            <Text size="sm" mb="sm">
              Received from <b>{p.payerName ?? '—'}</b> for{' '}
              <Link to={`/students/${p.studentId}?tab=finance`} style={{ color: 'inherit', fontWeight: 600 }}>
                {p.studentName}
              </Link>{' '}
              ({p.studentCode})
            </Text>
            <div style={{ borderTop: '1px solid var(--k-line)' }}>
              {(p.allocations ?? []).map((al, i) => (
                <Group key={i} justify="space-between" py={6}>
                  <Text size="sm">{al.feeItemName}</Text>
                  <Text size="sm">
                    <Money value={al.amountPesewas} />
                  </Text>
                </Group>
              ))}
              {(p.creditCreatedPesewas ?? 0) > 0 && (
                <Group justify="space-between" py={6}>
                  <Text size="sm">Kept as credit</Text>
                  <Text size="sm">
                    <Money value={p.creditCreatedPesewas} />
                  </Text>
                </Group>
              )}
            </div>
            <Group justify="space-between" pt="sm" style={{ borderTop: '2px solid var(--k-ink)' }} wrap="nowrap">
              <Text size="sm" fw={600}>
                Total paid · {PAYMENT_METHOD_LABELS[p.method ?? ''] ?? p.method}
                {p.referenceNo ? ` ${p.referenceNo}` : ''}
              </Text>
              <Text size="sm" fw={700}>
                <Money value={p.amountPesewas} />
              </Text>
            </Group>
            <Text size="sm" c="dimmed" mt="sm">
              Balance remaining: <Money value={p.balanceAfterPesewas} owes /> · Received by {(p as { recordedByName?: string }).recordedByName ?? p.recordedBy}
            </Text>
            {p.status === 'reversed' && (
              <Text size="sm" mt="sm">
                Reversed {formatDateTime(p.reversal?.reversedAt)} by {p.reversal?.reversedBy}: {p.reversal?.reason} ({p.reversal?.reversalNo})
              </Text>
            )}
          </Card>
          {p.status === 'confirmed' && !p.pendingReversal && (
            <Can perm="payments:reverse">
              <Button variant="default" w="fit-content" className="no-print" onClick={() => setReverseOpen(true)}>
                Reverse this payment
              </Button>
            </Can>
          )}
          <Modal opened={reverseOpen} onClose={() => setReverseOpen(false)} title={`Reverse receipt ${p.receiptNo}?`}>
            <Stack>
              <Text size="sm">The receipt keeps its number and is marked REVERSED. The amount goes back onto the student's balance. This cannot be undone.</Text>
              <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} data-autofocus />
              <ProblemAlert error={reverse.error} />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setReverseOpen(false)}>
                  Keep payment
                </Button>
                <Button color="red" disabled={reason.trim().length < 5} loading={reverse.isPending} onClick={() => reverse.mutate()}>
                  Reverse payment
                </Button>
              </Group>
            </Stack>
          </Modal>
        </Stack>
      )}
    </QueryState>
  );
}
