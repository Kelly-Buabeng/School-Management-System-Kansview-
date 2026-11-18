import { Badge, Button, Group, Modal, Select, SimpleGrid, Stack, Table, Tabs, Text, Textarea } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { listOf } from '@/api/normalise';
import { api } from '@/api/client';
import { useClasses, useLevels } from '@/api/queries';
import type { ListResponse, MessagePreview, MessageRecipient, MessageSummary, MessageTemplate, SendMessageRequest } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { Chip, EmptyState, Message, Money, PageHeader, QueryState, Section } from '@/components/ui';
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
  const [params] = useSearchParams();
  const studentIds = (params.get('students') ?? '').split(',').filter(Boolean);
  const classes = useClasses();
  const levels = useLevels();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<unknown>('/message-templates').then(listOf<MessageTemplate>) });
  const [kind, setKind] = useState<SendMessageRequest['kind']>(params.get('kind') === 'emergency' && can('messages:emergency') ? 'emergency' : 'announcement');
  const [audience, setAudience] = useState<'school' | 'class' | 'level' | 'defaulters' | 'students'>(studentIds.length ? 'students' : 'class');
  const [ids, setIds] = useState<string[]>(studentIds);
  const [body, setBody] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [key, setKey] = useState(() => newIdempotencyKey('msg'));
  const request = { kind, channel: 'sms' as const, body, audience: { type: audience, ids: audience === 'school' || audience === 'defaulters' ? [] : ids } };
  const ready = Boolean(body.trim()) && (audience === 'school' || audience === 'defaulters' || ids.length > 0);
  const [debouncedRequest] = useDebouncedValue(JSON.stringify(request), 500);
  const preview = useQuery({
    queryKey: ['message-preview', debouncedRequest],
    queryFn: () => api.post<MessagePreview>('/messages/preview', { body: JSON.parse(debouncedRequest) }),
    enabled: ready && debouncedRequest === JSON.stringify(request),
    staleTime: 30_000,
  });
  const send = useMutation({
    mutationFn: () => api.post<{ status: string; recipientCount: number }>('/messages', { body: request, idempotencyKey: key }),
    onSuccess: (r) => {
      notifications.show({ color: 'navy', message: r.status === 'awaiting_approval' ? 'Sent for approval. It goes out once approved.' : `Queued for ${r.recipientCount} guardians.` });
      setBody('');
      setReviewing(false);
      setKey(newIdempotencyKey('msg'));
      void qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
  const pick = (type: typeof audience, id?: string) => {
    if (!id) {
      setAudience(type);
      setIds([]);
      return;
    }
    if (audience !== type) {
      setAudience(type);
      setIds([id]);
    } else setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  };
  const p = preview.data;

  return (
    <Section style={{ maxWidth: 900 }}>
      <Stack gap="md">
        <div>
          <Text fw={500} mb={8}>
            Send to
          </Text>
          <Group gap="xs">
            {studentIds.length > 0 && (
              <Chip selected={audience === 'students'} onClick={() => { setAudience('students'); setIds(studentIds); }}>
                {studentIds.length} selected student(s)
              </Chip>
            )}
            <Chip selected={audience === 'school'} onClick={() => pick('school')}>
              Whole school
            </Chip>
            <Chip selected={audience === 'defaulters'} onClick={() => pick('defaulters')}>
              Guardians who owe fees
            </Chip>
          </Group>
          <Text size="xs" c="dimmed" mt="sm" mb={4}>
            Levels
          </Text>
          <Group gap="xs">
            {(levels.data ?? []).map((l) => (
              <Chip key={l.id} selected={audience === 'level' && ids.includes(l.id)} onClick={() => pick('level', l.id)}>
                {l.name}
              </Chip>
            ))}
          </Group>
          <Text size="xs" c="dimmed" mt="sm" mb={4}>
            Classes
          </Text>
          <Group gap="xs">
            {(classes.data ?? []).map((c) => (
              <Chip key={c.id} selected={audience === 'class' && ids.includes(c.id)} onClick={() => pick('class', c.id)}>
                {c.name}
              </Chip>
            ))}
          </Group>
        </div>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="Type of message"
            data={Object.entries(KINDS)
              .filter(([k]) => k !== 'emergency' || can('messages:emergency'))
              .map(([value, label]) => ({ value, label }))}
            value={kind}
            onChange={(v) => setKind((v ?? 'announcement') as typeof kind)}
            allowDeselect={false}
          />
          <Select
            label="Start from a template (optional)"
            data={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            onChange={(id) => {
              const t = templates.data?.find((x) => x.id === id);
              if (t) {
                setBody(t.body);
                if (kind !== 'emergency') setKind(t.kind);
              }
            }}
            clearable
          />
        </SimpleGrid>
        <div>
          <Textarea label="Message" description="Placeholders like {guardian_name}, {student_name}, {balance} are filled in for each guardian." value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={3} maxLength={640} />
          <Text size="xs" c="dimmed" ta="right">
            {body.length}/640 characters
          </Text>
        </div>
        <Text size="sm" c="dimmed" aria-live="polite">
          {!ready ? 'Choose who to send to and write the message.' : preview.isFetching && !p ? 'Counting guardians…' : p ? `This will send an SMS to ${p.recipientCount} guardians.` : ''}
        </Text>
        <ProblemAlert error={preview.error ?? send.error} />
        <Button size="md" w="fit-content" color={kind === 'emergency' ? 'red' : undefined} disabled={!ready || !p || p.recipientCount === 0} onClick={() => setReviewing(true)}>
          Review and send
        </Button>
      </Stack>
      <Modal opened={reviewing && Boolean(p)} onClose={() => setReviewing(false)} title={kind === 'emergency' ? 'Send emergency message now?' : 'Review and send'} size="lg">
        {p && (
          <Stack>
            <Group gap="xl" wrap="wrap">
              <Text>
                <b>{p.recipientCount}</b> guardians
              </Text>
              <Text>
                <b>{p.segmentsPerMessage}</b> SMS each ({p.encoding})
              </Text>
              <Text>
                About <b><Money value={p.estimatedCostPesewas} /></b>
              </Text>
            </Group>
            {p.encoding === 'Unicode' && <Message kind="warning">Special characters make each SMS shorter (70 characters) and more expensive.</Message>}
            {p.needsApproval && <Message kind="warning">More than 50 recipients: the administrator must approve before it is sent.</Message>}
            <Text size="sm" fw={600}>
              Example:
            </Text>
            {p.samples.slice(0, 2).map((s, i) => (
              <Text key={i} size="sm" p="xs" bg="var(--k-paper)" style={{ borderRadius: 6 }}>
                {s}
              </Text>
            ))}
            <Text size="sm">Messages cannot be called back once sent.</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReviewing(false)}>
                Back
              </Button>
              <Button color={kind === 'emergency' ? 'red' : undefined} loading={send.isPending} onClick={() => send.mutate()}>
                {p.needsApproval ? 'Send for approval' : 'Send'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Section>
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
                        <Badge color={r.status === 'delivered' ? 'green' : r.status === 'failed' ? 'red' : 'gray'} variant="default">
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
                <Button mt="sm" variant="default" onClick={() => retry.mutate()} loading={retry.isPending}>
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
                      <Badge color={STATUS[m.status]?.color} variant="default">
                        {STATUS[m.status]?.label ?? m.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {m.delivered}/{m.recipientCount}
                      {m.failed > 0 && <Text span c="red.8"> · {m.failed} failed</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Button size="compact-xs" variant="default" onClick={() => setOpen(m)}>
                          Log
                        </Button>
                        {m.status === 'awaiting_approval' && m.createdBy !== me?.fullName && (
                          <Can perm="messages:bulk_approve">
                            <Button size="compact-xs" onClick={() => approve.mutate(m.id)}>
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
  const [params] = useSearchParams();
  const emergency = params.get('kind') === 'emergency';
  return (
    <>
      <PageHeader title={emergency ? 'Bulk emergency message' : 'Bulk message'} subtitle="SMS go out from the school's account. Non-emergency messages wait until 07:00 if sent at night." />
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
