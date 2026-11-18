import { Alert, Anchor, Avatar, Box, Button, Card, Group, Image, Paper, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '@/api/client';
import type { ContactOutcome, EmergencyContact, EmergencyViewData } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';
import { QueryState } from '@/components/ui';
import { OfflineBanner } from '@/layout/OfflineBanner';
import { displayPhone, formatDateTime } from '@/lib/format';

const OUTCOMES: { value: ContactOutcome; label: string; color: string }[] = [
  { value: 'reached', label: 'Spoke to them', color: 'green' },
  { value: 'no_answer', label: 'No answer', color: 'orange' },
  { value: 'message_left', label: 'Left a message', color: 'blue' },
  { value: 'wrong_number', label: 'Wrong number', color: 'red' },
];
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label])) as Record<ContactOutcome, string>;

/** Phone-first emergency screen. Big text, one tap to call, then log what happened. Opening it is audited. */
export default function EmergencyViewPage() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['emergency', id],
    queryFn: () => api.get<EmergencyViewData>('/students/{id}/emergency-view', { path: { id } }),
    staleTime: 0,
  });
  const [called, setCalled] = useState<{ name: string; phone: string } | null>(null);

  return (
    <Box bg="gray.0" mih="100vh" fz="lg">
      <OfflineBanner />
      <Paper p="sm" radius={0} shadow="xs" className="no-print">
        <Anchor component={Link} to={`/students/${id}`} size="md" fw={600}>
          ← Back to student record
        </Anchor>
      </Paper>
      <Box p="sm" maw={720} mx="auto">
        <QueryState query={query} label="Loading emergency details…">
          {(ev) => (
            <Stack gap="md">
              <Group wrap="nowrap" gap="md">
                <Avatar src={ev.student.photoUrl} size={88} radius="md" alt={`Photo of ${ev.student.fullName}`} />
                <div style={{ minWidth: 0 }}>
                  <Title order={1} fz={28} lh={1.15}>
                    {ev.student.fullName}
                  </Title>
                  <Text fz={20} fw={600}>
                    {ev.student.className ?? 'No class'}
                  </Text>
                  <Text fz="md" c="dimmed" ff="monospace">
                    {ev.student.studentCode}
                  </Text>
                </div>
              </Group>

              {ev.alertSummary ? (
                <Alert color="red" variant="filled" radius="md" p="md" role="alert" title={<Text fz={22} fw={800}>MEDICAL ALERT</Text>}>
                  <Text fz={22} fw={700} lh={1.3}>
                    {ev.alertSummary}
                  </Text>
                </Alert>
              ) : (
                <Alert color="gray" radius="md">
                  <Text fz="lg">No medical alert recorded.</Text>
                </Alert>
              )}

              <SimpleGrid cols={{ base: 1, xs: 2 }}>
                <Card withBorder radius="md" bg={ev.allergies ? 'red.0' : undefined}>
                  <Text fz="sm" fw={700} c="dimmed" tt="uppercase">
                    Allergies
                  </Text>
                  <Text fz={20} fw={700} c={ev.allergies ? 'red.9' : undefined}>
                    {ev.allergies || 'None recorded'}
                  </Text>
                </Card>
                <Card withBorder radius="md">
                  <Text fz="sm" fw={700} c="dimmed" tt="uppercase">
                    Blood group
                  </Text>
                  <Text fz={20} fw={700}>
                    {ev.bloodGroup && ev.bloodGroup !== 'unknown' ? ev.bloodGroup : 'Not known'}
                  </Text>
                </Card>
              </SimpleGrid>

              <Title order={2} fz={22}>
                Call in this order
              </Title>
              {ev.contacts.length === 0 && <Alert color="orange">No emergency contacts recorded. Check the parents on the student record.</Alert>}
              {ev.contacts.map((c) => (
                <ContactCard key={`${c.priority}-${c.name}`} contact={c} onCall={(phone) => setCalled({ name: c.name, phone })} />
              ))}
              {ev.doctor?.name && (
                <Card withBorder radius="md">
                  <Text fz="sm" fw={700} c="dimmed" tt="uppercase">
                    Doctor / clinic
                  </Text>
                  <Text fz={20} fw={600}>
                    {ev.doctor.name}
                    {ev.doctor.clinic ? `, ${ev.doctor.clinic}` : ''}
                  </Text>
                  {ev.doctor.phone && (
                    <Button component="a" href={`tel:${ev.doctor.phone}`} size="lg" mt="xs" variant="light" fullWidth onClick={() => setCalled({ name: ev.doctor!.name!, phone: ev.doctor!.phone! })}>
                      Call clinic {displayPhone(ev.doctor.phone)}
                    </Button>
                  )}
                </Card>
              )}

              <Title order={2} fz={22}>
                Allowed to pick up
              </Title>
              {ev.authorisedPickups.length === 0 ? (
                <Text>No one recorded. Only release the child to a parent on the record.</Text>
              ) : (
                <SimpleGrid cols={{ base: 1, xs: 2 }}>
                  {ev.authorisedPickups.map((p) => (
                    <Card key={p.id} withBorder radius="md">
                      <Group wrap="nowrap">
                        {p.photoUrl ? <Image src={p.photoUrl} w={72} h={72} radius="md" alt={`Photo of ${p.name}`} /> : <Avatar size={72} radius="md" alt="" />}
                        <div>
                          <Text fz={20} fw={700}>
                            {p.name}
                          </Text>
                          <Text fz="md">{p.relationship}</Text>
                          {p.notes && <Text fz="sm" c="dimmed">{p.notes}</Text>}
                        </div>
                      </Group>
                    </Card>
                  ))}
                </SimpleGrid>
              )}

              {ev.recentContactLog.length > 0 && (
                <>
                  <Title order={2} fz={18}>
                    Recent calls
                  </Title>
                  {ev.recentContactLog.map((l) => (
                    <Text key={l.id} fz="md">
                      {formatDateTime(l.at)} — {l.byName} called {l.contactName}: <b>{OUTCOME_LABEL[l.outcome] ?? l.outcome}</b>
                      {l.notes ? ` (${l.notes})` : ''}
                    </Text>
                  ))}
                </>
              )}
            </Stack>
          )}
        </QueryState>
      </Box>
      {called && <LogCall studentId={id} called={called} onDone={() => setCalled(null)} />}
    </Box>
  );
}

function ContactCard({ contact, onCall }: { contact: EmergencyContact; onCall: (phone: string) => void }) {
  return (
    <Card withBorder radius="md" p="md">
      <Group gap="sm" wrap="nowrap" mb="xs">
        <Text fz={28} fw={800} c="blue.8" w={36} ta="center" aria-label={`Number ${contact.priority}`}>
          {contact.priority}
        </Text>
        <div>
          <Text fz={22} fw={700} lh={1.2}>
            {contact.name}
          </Text>
          <Text fz="lg">{contact.relationship}</Text>
        </div>
      </Group>
      <Stack gap="xs">
        {contact.phones.map((ph, i) => (
          <Button key={ph} component="a" href={contact.telLinks[i] ?? `tel:${ph}`} size="xl" color="green" fullWidth onClick={() => onCall(ph)} aria-label={`Call ${contact.name} on ${displayPhone(ph)}`} styles={{ label: { fontSize: 22 } }}>
            Call {displayPhone(ph)}
          </Button>
        ))}
      </Stack>
    </Card>
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
            <Button key={o.value} size="lg" color={o.color} onClick={() => log.mutate(o.value)} loading={log.isPending && log.variables === o.value}>
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
