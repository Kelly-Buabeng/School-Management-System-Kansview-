import { Alert, Button, Card, Group, Modal, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, downloadFile } from '@/api/client';
import type { Payment } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { formatDateTime, PAYMENT_METHOD_LABELS } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

type PaymentDetail = Payment & { pendingReversal?: { requestedBy: string; reason: string; at: string } | null; awaitingApproval?: boolean };

export default function ReceiptPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { me } = useAuth();
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
        <Stack maw={640}>
          <PageHeader
            title={`Receipt ${p.receiptNo}`}
            actions={
              <Group className="no-print">
                <Button variant="light" onClick={() => window.print()}>
                  Print
                </Button>
                <Button variant="light" onClick={() => pdf.mutate()} loading={pdf.isPending}>
                  PDF receipt
                </Button>
              </Group>
            }
          />
          {params.get('new') && (
            <Alert color="green" title="Saved" className="no-print">
              The server confirmed this payment. Give the receipt number {p.receiptNo} to the payer.
            </Alert>
          )}
          {p.status === 'reversed' && (
            <Alert color="red" title="REVERSED">
              Reversed {formatDateTime(p.reversal?.reversedAt)} by {p.reversal?.reversedBy}: {p.reversal?.reason} ({p.reversal?.reversalNo})
            </Alert>
          )}
          {p.pendingReversal && (
            <Alert color="yellow" title="Reversal waiting for approval">
              Requested by {p.pendingReversal.requestedBy}: {p.pendingReversal.reason}
              <Can perm="payments:reverse_approve">
                {p.pendingReversal.requestedBy !== me?.fullName && (
                  <Button mt="xs" size="xs" color="red" onClick={() => approve.mutate()} loading={approve.isPending} display="block">
                    Approve reversal
                  </Button>
                )}
              </Can>
            </Alert>
          )}
          <Card withBorder>
            <Table>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Th w={160}>Student</Table.Th>
                  <Table.Td>
                    <Link to={`/students/${p.studentId}?tab=finance`}>{p.studentName}</Link> ({p.studentCode})
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Amount</Table.Th>
                  <Table.Td fw={700} fz="lg">
                    <Money value={p.amountPesewas} />
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Method</Table.Th>
                  <Table.Td>
                    {PAYMENT_METHOD_LABELS[p.method ?? ''] ?? p.method}
                    {p.referenceNo ? ` — ref. ${p.referenceNo}` : ''}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Received</Table.Th>
                  <Table.Td>{formatDateTime(p.receivedAt)}</Table.Td>
                </Table.Tr>
                {p.payerName && (
                  <Table.Tr>
                    <Table.Th>Paid by</Table.Th>
                    <Table.Td>{p.payerName}</Table.Td>
                  </Table.Tr>
                )}
                <Table.Tr>
                  <Table.Th>Status</Table.Th>
                  <Table.Td>
                    <StatusBadge status={p.status ?? 'confirmed'} />
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Recorded by</Table.Th>
                  <Table.Td>{p.recordedBy}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
            <Title order={2} size="h5" mt="md">
              Applied to
            </Title>
            <Table fz="sm">
              <Table.Tbody>
                {(p.allocations ?? []).map((a, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{a.feeItemName}</Table.Td>
                    <Table.Td ta="right">
                      <Money value={a.amountPesewas} />
                    </Table.Td>
                  </Table.Tr>
                ))}
                {(p.creditCreatedPesewas ?? 0) > 0 && (
                  <Table.Tr>
                    <Table.Td>Kept as credit</Table.Td>
                    <Table.Td ta="right">
                      <Money value={p.creditCreatedPesewas} />
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
            <Text mt="sm" size="sm">
              Balance after this payment: <Money value={p.balanceAfterPesewas} owes />
            </Text>
          </Card>
          {p.status === 'confirmed' && !p.pendingReversal && (
            <Can perm="payments:reverse">
              <Button color="red" variant="outline" w="fit-content" className="no-print" onClick={() => setReverseOpen(true)}>
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
