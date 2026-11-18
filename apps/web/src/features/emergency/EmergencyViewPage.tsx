import { Avatar, Button, Group, Image, Paper, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '@/api/client';
import type { ContactOutcome, EmergencyViewData } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';
import { QueryState, Section } from '@/components/ui';
import { displayPhone, formatDateTime } from '@/lib/format';

const OUTCOMES: { value: ContactOutcome; label: string }[] = [
  { value: 'reached', label: 'Spoke to them' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'message_left', label: 'Left a message' },
  { value: 'wrong_number', label: 'Wrong number' },
];
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label])) as Record<ContactOutcome, string>;
const row = { borderTop: '1px solid var(--k-line)', padding: '12px 0' } as const;

/** Emergency View: red header, medical alerts, contacts in call order with one-tap Call, then log what happened. Opening it is audited. */
export default function EmergencyViewPage() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['emergency', id],
    queryFn: () => api.get<EmergencyViewData>('/students/{id}/emergency-view', { path: { id } }),
    staleTime: 0,
  });
  const [called, setCalled] = useState<{ name: string; phone: string } | null>(null);

  return (
    <>
      <QueryState query={query} label="Loading emergency details…">
        {(ev) => (
          <Stack gap="md" maw={1000}>
            <Paper p="lg" radius="md" style={{ background: 'var(--k-red)', color: '#fff' }}>
              <Group wrap="nowrap" gap="md">
                <Avatar src={ev.student.photoUrl} size={64} radius="md" alt={`Photo of ${ev.student.fullName}`} />
                <div style={{ minWidth: 0 }}>
                  <Text size="xs" tt="uppercase" style={{ letterSpacing: 1 }}>
                    Emergency view
                  </Text>
                  <Title order={1} c="#fff" fz={30} lh={1.15}>
                    {ev.student.fullName} · {ev.student.className ?? 'No class'}
                  </Title>
                  <Text size="sm" opacity={0.9}>
                    {ev.student.studentCode}
                  </Text>
                </div>
              </Group>
            </Paper>

            <div role="alert" aria-label="Medical alerts" className="k-msg k-msg-danger" style={{ padding: 16 }}>
              <Text fw={700} fz={16} mb={4}>
                Medical alerts
              </Text>
              <Text fz={20} fw={600} c="var(--k-red)" lh={1.3}>
                {ev.alertSummary || 'No medical alert recorded.'}
              </Text>
              <Text fz={16} mt={6}>
                <b>Allergies:</b> {ev.allergies || 'None recorded'} · <b>Blood group:</b> {ev.bloodGroup && ev.bloodGroup !== 'unknown' ? ev.bloodGroup : 'Not known'}
              </Text>
            </div>

            <Section title="Call in this order">
              {ev.contacts.length === 0 && <Text>No emergency contacts recorded. Check the parents on the student record.</Text>}
              {ev.contacts.map((c) => (
                <div key={`${c.priority}-${c.name}`} style={row}>
                  <Group justify="space-between" wrap="nowrap" align="center">
                    <div style={{ minWidth: 0 }}>
                      <Text fz={18} fw={600}>
                        {c.priority}. {c.name}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {c.relationship} · {c.phones.map(displayPhone).join(' · ')}
                      </Text>
                    </div>
                    <Stack gap={6}>
                      {c.phones.map((ph, i) => (
                        <Button key={ph} component="a" href={c.telLinks[i] ?? `tel:${ph}`} size="lg" onClick={() => setCalled({ name: c.name, phone: ph })} aria-label={`Call ${c.name} on ${displayPhone(ph)}`} miw={88}>
                          Call
                        </Button>
                      ))}
                    </Stack>
                  </Group>
                </div>
              ))}
              {ev.doctor?.name && (
                <div style={row}>
                  <Group justify="space-between" wrap="nowrap">
                    <div>
                      <Text fz={18} fw={600}>
                        Doctor: {ev.doctor.name}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {[ev.doctor.clinic, displayPhone(ev.doctor.phone)].filter(Boolean).join(' · ')}
                      </Text>
                    </div>
                    {ev.doctor.phone && (
                      <Button component="a" href={`tel:${ev.doctor.phone}`} size="lg" variant="default" onClick={() => setCalled({ name: ev.doctor!.name!, phone: ev.doctor!.phone! })} aria-label={`Call clinic ${displayPhone(ev.doctor.phone)}`}>
                        Call
                      </Button>
                    )}
                  </Group>
                </div>
              )}
            </Section>

            <Section title="Allowed to pick up">
              {ev.authorisedPickups.length === 0 ? (
                <Text>No one recorded. Only release the child to a parent on the record.</Text>
              ) : (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  {ev.authorisedPickups.map((p) => (
                    <Group key={p.id} wrap="nowrap">
                      {p.photoUrl ? <Image src={p.photoUrl} w={64} h={64} radius="md" alt={`Photo of ${p.name}`} /> : <Avatar size={64} radius="md" alt="" />}
                      <div>
                        <Text fz={18} fw={600}>
                          {p.name}
                        </Text>
                        <Text size="sm">{p.relationship}</Text>
                        {p.notes && (
                          <Text size="xs" c="dimmed">
                            {p.notes}
                          </Text>
                        )}
                      </div>
                    </Group>
                  ))}
                </SimpleGrid>
              )}
            </Section>

            <Section title="Contact log">
              {ev.recentContactLog.length === 0 ? (
                <Text size="sm">No calls logged for this student recently.</Text>
              ) : (
                ev.recentContactLog.map((l) => (
                  <Text key={l.id} size="sm" py={4}>
                    {formatDateTime(l.at)} — {l.byName} called {l.contactName}: <b>{OUTCOME_LABEL[l.outcome] ?? l.outcome}</b>
                    {l.notes ? ` (${l.notes})` : ''}
                  </Text>
                ))
              )}
            </Section>

            <Group className="no-print">
              <Can perm="messages:emergency">
                <Button component={Link} to="/messages?kind=emergency" variant="outline" color="red" size="md">
                  Send a bulk emergency message
                </Button>
              </Can>
              <Button component={Link} to={`/students/${id}`} variant="default" size="md">
                Back to student record
              </Button>
            </Group>
          </Stack>
        )}
      </QueryState>
      {called && <LogCall studentId={id} called={called} onDone={() => setCalled(null)} />}
    </>
  );
}

function LogCall({ studentId, called, onDone }: { studentId: string; called: { name: string; phone: string }; onDone: () => void }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const log = useMutation({
    mutationFn: (outcome: ContactOutcome) => api.post('/students/{id}/emergency-contact-logs', { path: { id: studentId }, body: { contactName: called.name, phone: called.phone, outcome, notes: notes.trim() || undefined } }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Call logged.' });
      void qc.invalidateQueries({ queryKey: ['emergency', studentId] });
      onDone();
    },
  });
  return (
    <Can perm="emergency_log:create">
      <Paper shadow="xl" withBorder p="md" radius="md" pos="fixed" bottom={8} left={8} right={8} maw={704} mx="auto" style={{ zIndex: 400 }} role="dialog" aria-label="How did the call go?">
        <Text fz={20} fw={700} mb="xs">
          How did the call to {called.name} go?
        </Text>
        <SimpleGrid cols={2} spacing="xs">
          {OUTCOMES.map((o) => (
            <Button key={o.value} size="lg" variant={o.value === "reached" ? "filled" : "default"} onClick={() => log.mutate(o.value)} loading={log.isPending && log.variables === o.value}>
              {o.label}
            </Button>
          ))}
        </SimpleGrid>
        <Textarea mt="xs" label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize minRows={1} />
        <ProblemAlert error={log.error} />
        <Button variant="subtle" mt={4} onClick={onDone}>
          Skip
        </Button>
      </Paper>
    </Can>
  );
}
