import { Alert, Badge, Button, Card, Group, Modal, MultiSelect, Select, SimpleGrid, Stack, Table, Tabs, Text, Textarea } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listOf } from '@/api/normalise';
import { api } from '@/api/client';
import { classOptions, useClasses, useLevels } from '@/api/queries';
import type { ListResponse, MessagePreview, MessageRecipient, MessageSummary, MessageTemplate, SendMessageRequest } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { EmptyState, Money, PageHeader, QueryState } from '@/components/ui';
import { displayPhone, formatDateTime } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

const KINDS: Record<SendMessageRequest['kind'], string> = {
  announcement: 'Announcement',
  fee_reminder: 'Fee reminder',
  absence_alert: 'Absence alert',
  closure_notice: 'School closure',
  emergency: 'EMERGENCY (sends at once)',
};
const STATUS: Record<MessageSummary['status'], { label: string; color: string }> = {
  awaiting_approval: { label: 'Waiting for approval', color: 'yellow' },
  queued: { label: 'Queued', color: 'blue' },
  sending: { label: 'Sending', color: 'blue' },
  sent: { label: 'Sent', color: 'green' },
  partly_failed: { label: 'Some failed', color: 'orange' },
  failed: { label: 'Failed', color: 'red' },
};

function Compose() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const classes = useClasses();
  const levels = useLevels();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<unknown>('/message-templates').then(listOf<MessageTemplate>) });
  const [kind, setKind] = useState<SendMessageRequest['kind']>('announcement');
  const [audience, setAudience] = useState<'school' | 'class' | 'level' | 'defaulters'>('class');
  const [ids, setIds] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [key, setKey] = useState(() => newIdempotencyKey('msg'));
  const request = { kind, channel: 'sms' as const, body, audience: { type: audience, ids: audience === 'class' || audience === 'level' ? ids : [] } };
  const preview = useMutation({ mutationFn: () => api.post<MessagePreview>('/messages/preview', { body: request }) });
  const send = useMutation({
    mutationFn: () => api.post<{ status: string; recipientCount: number }>('/messages', { body: request, idempotencyKey: key }),
    onSuccess: (r) => {
      notifications.show({ color: 'green', message: r.status === 'awaiting_approval' ? 'Sent for approval. It goes out once approved.' : `Queued for ${r.recipientCount} parents.` });
      setBody('');
      preview.reset();
      setKey(newIdempotencyKey('msg'));
      void qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
  const ready = body.trim() && (audience === 'school' || audience === 'defaulters' || ids.length > 0);
  return (
    <Stack maw={760}>
      <Card withBorder>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label="Type of message" data={Object.entries(KINDS).filter(([k]) => k !== 'emergency' || can('messages:emergency')).map(([value, label]) => ({ value, label }))} value={kind} onChange={(v) => { setKind((v ?? 'announcement') as typeof kind); preview.reset(); }} allowDeselect={false} />
          <Select
            label="Send to parents of"
            data={[{ value: 'class', label: 'Some classes' }, { value: 'level', label: 'Some levels' }, { value: 'school', label: 'Whole school' }, { value: 'defaulters', label: 'Students who owe fees' }]}
            value={audience}
            onChange={(v) => { setAudience((v ?? 'class') as typeof audience); setIds([]); preview.reset(); }}
            allowDeselect={false}
          />
          {(audience === 'class' || audience === 'level') && (
            <MultiSelect label={audience === 'class' ? 'Classes' : 'Levels'} data={audience === 'class' ? classOptions(classes.data) : (levels.data ?? []).map((l) => ({ value: l.id, label: l.name }))} value={ids} onChange={(v) => { setIds(v); preview.reset(); }} />
          )}
          <Select label="Start from a template (optional)" data={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(id) => { const t = templates.data?.find((x) => x.id === id); if (t) { setBody(t.body); setKind(t.kind); preview.reset(); } }} clearable />
        </SimpleGrid>
        <Textarea mt="sm" label="Message" description="Placeholders like {guardian_name}, {student_name}, {balance} are filled in for each parent." value={body} onChange={(e) => { setBody(e.currentTarget.value); preview.reset(); }} autosize minRows={3} maxLength={640} />
        <Text size="xs" c="dimmed" ta="right">
          {body.length}/640 characters
        </Text>
        <Group mt="sm">
          <Button variant="light" disabled={!ready} loading={preview.isPending} onClick={() => preview.mutate()}>
            Preview cost and recipients
          </Button>
        </Group>
        <ProblemAlert error={preview.error ?? send.error} />
      </Card>
      {preview.data && (
        <Card withBorder>
          <Group gap="xl" mb="sm" wrap="wrap">
            <Text>
              <b>{preview.data.recipientCount}</b> parents
            </Text>
            <Text>
              <b>{preview.data.segmentsPerMessage}</b> SMS each ({preview.data.encoding})
            </Text>
            <Text>
              About <b><Money value={preview.data.estimatedCostPesewas} /></b>
            </Text>
          </Group>
          {preview.data.encoding === 'Unicode' && <Alert color="yellow" mb="sm">Special characters make each SMS shorter (70 characters) and more expensive.</Alert>}
          {preview.data.needsApproval && <Alert color="yellow" mb="sm">More than 50 recipients: the administrator must approve before it is sent.</Alert>}
          <Text size="sm" fw={600}>Example:</Text>
          {preview.data.samples.slice(0, 2).map((s, i) => (
            <Text key={i} size="sm" p="xs" bg="gray.0" mb={4} style={{ borderRadius: 6 }}>
              {s}
            </Text>
          ))}
          <Button
            mt="sm"
            color={kind === 'emergency' ? 'red' : undefined}
            loading={send.isPending}
            disabled={preview.data.recipientCount === 0}
            onClick={() =>
              modals.openConfirmModal({
                title: `Send to ${preview.data!.recipientCount} parents?`,
                children: <Text size="sm">Messages cannot be called back once sent.</Text>,
                labels: { confirm: preview.data!.needsApproval ? 'Send for approval' : 'Send', cancel: 'Cancel' },
                onConfirm: () => send.mutate(),
              })
            }
          >
            {preview.data.needsApproval ? 'Send for approval' : 'Send'}
          </Button>
        </Card>
      )}
    </Stack>
  );
}

function DeliveryLog({ m, onClose }: { m: MessageSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['message', m.id, 'recipients'], queryFn: () => api.get<unknown>('/messages/{id}/recipients', { path: { id: m.id } }).then(listOf<MessageRecipient>) });
  const retry = useMutation({ mutationFn: () => api.post('/messages/{id}/retry-failed', { path: { id: m.id } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['message', m.id] }) });
  return (
    <Modal opened onClose={onClose} title="Delivery log" size="lg">
      <QueryState query={query}>
        {(list) => (
          <>
            <div className="table-scroll">
              <Table fz="sm" miw={480}>
                <Table.Tbody>
                  {list.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td>{r.guardianName}</Table.Td>
                      <Table.Td>{displayPhone(r.phone)}</Table.Td>
                      <Table.Td>
                        <Badge color={r.status === 'delivered' ? 'green' : r.status === 'failed' ? 'red' : 'gray'} variant="light">
                          {r.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{r.error}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            {list.some((r) => r.status === 'failed') && (
              <Can perm="messages:send">
                <Button mt="sm" variant="light" onClick={() => retry.mutate()} loading={retry.isPending}>
                  Retry failed
                </Button>
              </Can>
            )}
          </>
        )}
      </QueryState>
    </Modal>
  );
}

function Log() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const [open, setOpen] = useState<MessageSummary | null>(null);
  const query = useQuery({ queryKey: ['messages'], queryFn: () => api.get<unknown>('/messages').then(listOf<MessageSummary>) });
  const approve = useMutation({ mutationFn: (id: string) => api.post('/messages/{id}/approve', { path: { id } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['messages'] }), onError: (e) => notifications.show(notifyError(e)) });
  return (
    <QueryState query={query}>
      {(list) =>
        list.length === 0 ? (
          <EmptyState>No messages yet.</EmptyState>
        ) : (
          <div className="table-scroll">
            <Table miw={720} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Message</Table.Th>
                  <Table.Th>To</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Delivered</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((m) => (
                  <Table.Tr key={m.id}>
                    <Table.Td>{formatDateTime(m.createdAt)}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{m.bodyPreview}</Text>
                      <Text size="xs" c="dimmed">
                        {KINDS[m.kind]} · by {m.createdBy}
                      </Text>
                    </Table.Td>
                    <Table.Td>{m.audienceLabel} ({m.recipientCount})</Table.Td>
                    <Table.Td>
                      <Badge color={STATUS[m.status]?.color} variant="light">
                        {STATUS[m.status]?.label ?? m.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {m.delivered}/{m.recipientCount}
                      {m.failed > 0 && <Text span c="red.8"> · {m.failed} failed</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Button size="compact-xs" variant="light" onClick={() => setOpen(m)}>
                          Log
                        </Button>
                        {m.status === 'awaiting_approval' && m.createdBy !== me?.fullName && (
                          <Can perm="messages:bulk_approve">
                            <Button size="compact-xs" color="green" onClick={() => approve.mutate(m.id)}>
                              Approve
                            </Button>
                          </Can>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {open && <DeliveryLog m={open} onClose={() => setOpen(null)} />}
          </div>
        )
      }
    </QueryState>
  );
}

export default function MessagesPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Messages to parents" subtitle="SMS go out from the school's account. Non-emergency messages wait until 07:00 if sent at night." />
      <Tabs defaultValue={can('messages:send') ? 'compose' : 'log'}>
        <Tabs.List mb="md">
          {can('messages:send') && <Tabs.Tab value="compose">New message</Tabs.Tab>}
          <Tabs.Tab value="log">Sent messages</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="compose">
          <Compose />
        </Tabs.Panel>
        <Tabs.Panel value="log">
          <Log />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
