import { Alert, Avatar, Badge, Button, Card, FileInput, Group, Select, SimpleGrid, Stack, Table, Tabs, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { listOf, normGuardianLinks } from '@/api/normalise';
import { api, upload } from '@/api/client';
import type { AttendanceSummaryRow, Enrolment, Incident, ListResponse, Payment, Page, Student, StudentDocument, StudentGuardianLink, StudentMedical, StudentSummary } from '@/api/types';
import { Can, useAuth } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';
import { EmptyState, Money, PageHeader, QueryState, StatusBadge } from '@/components/ui';
import { BalanceSummary, LedgerTable } from '@/features/finance/LedgerTable';
import { displayPhone, formatDate, formatDateTime, PAYMENT_METHOD_LABELS, STATUS_LABELS, todayInAccra } from '@/lib/format';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500}>
        {children || '—'}
      </Text>
    </div>
  );
}

export default function StudentProfilePage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const query = useQuery({ queryKey: ['student', id], queryFn: () => api.get<Student>('/students/{id}', { path: { id } }) });

  return (
    <QueryState query={query} label="Loading student…">
      {(s) => (
        <>
          <PageHeader
            title={
              <Group gap="sm" wrap="nowrap">
                <Avatar src={s.photoUrl} size="lg" alt={`Photo of ${s.fullName}`} />
                <div>
                  <span>{s.fullName}</span>
                  <Text size="sm" c="dimmed" ff="monospace">
                    {s.studentCode} · {s.className ?? 'No class'}
                  </Text>
                </div>
              </Group>
            }
            actions={
              <>
                <Can perm="emergency_view:read">
                  <Button component={Link} to={`/students/${id}/emergency`} color="red">
                    Emergency View
                  </Button>
                </Can>
                <Can perm="payments:create">
                  <Button component={Link} to={`/finance/payments/new?studentId=${id}`} variant="light">
                    Record payment
                  </Button>
                </Can>
              </>
            }
          />
          <Group gap="xs" mb="sm">
            {s.status && <StatusBadge status={s.status} label={STATUS_LABELS[s.status]} />}
            {s.hasMedicalAlert && <Badge color="red">Medical alert — see Emergency View</Badge>}
          </Group>
          <Tabs value={tab} onChange={(v) => setParams({ tab: v ?? 'overview' }, { replace: true })} keepMounted={false}>
            <Tabs.List style={{ overflowX: 'auto', flexWrap: 'nowrap' }}>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              {can('guardians:read') && <Tabs.Tab value="family">Parents & siblings</Tabs.Tab>}
              {can('medical:read') && <Tabs.Tab value="medical">Medical</Tabs.Tab>}
              {can('student_documents:read') && <Tabs.Tab value="documents">Documents</Tabs.Tab>}
              {can('enrolments:read') && <Tabs.Tab value="enrolment">Class history</Tabs.Tab>}
              {can('balances:read') && <Tabs.Tab value="finance">Fees</Tabs.Tab>}
              {can('attendance:read') && <Tabs.Tab value="attendance">Attendance</Tabs.Tab>}
              {can('incidents:read') && <Tabs.Tab value="incidents">Incidents</Tabs.Tab>}
            </Tabs.List>
            <Tabs.Panel value="overview" pt="md">
              <Overview s={s} />
            </Tabs.Panel>
            <Tabs.Panel value="family" pt="md">
              <Family id={id} />
            </Tabs.Panel>
            <Tabs.Panel value="medical" pt="md">
              <Medical id={id} />
            </Tabs.Panel>
            <Tabs.Panel value="documents" pt="md">
              <Documents id={id} />
            </Tabs.Panel>
            <Tabs.Panel value="enrolment" pt="md">
              <Enrolments id={id} />
            </Tabs.Panel>
            <Tabs.Panel value="finance" pt="md">
              <Finance id={id} />
            </Tabs.Panel>
            <Tabs.Panel value="attendance" pt="md">
              <Attendance classId={s.currentEnrolment?.classId ?? s.classId} />
            </Tabs.Panel>
            <Tabs.Panel value="incidents" pt="md">
              <Incidents id={id} />
            </Tabs.Panel>
          </Tabs>
        </>
      )}
    </QueryState>
  );
}

function Overview({ s }: { s: Student }) {
  return (
    <Card withBorder>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
        <Field label="First name">{s.firstName}</Field>
        <Field label="Other names">{s.middleNames}</Field>
        <Field label="Surname">{s.lastName}</Field>
        <Field label="Date of birth">{formatDate(s.dateOfBirth)}</Field>
        <Field label="Gender">{s.gender === 'female' ? 'Female' : s.gender === 'male' ? 'Male' : ''}</Field>
        <Field label="Nationality">{s.nationality}</Field>
        <Field label="Admitted on">{formatDate(s.admissionDate)}</Field>
        <Field label="Previous school">{s.previousSchool}</Field>
        <Field label="Birth certificate no.">{s.birthCertNo}</Field>
        <Field label="Religion">{s.religion}</Field>
        <Field label="Languages">{s.languages?.join(', ')}</Field>
        {s.homeAddress !== undefined && <Field label="Home address">{s.homeAddress}</Field>}
        {s.balancePesewas !== undefined && (
          <Field label="Fee balance">
            <Money value={s.balancePesewas} owes />
          </Field>
        )}
      </SimpleGrid>
    </Card>
  );
}

function Family({ id }: { id: string }) {
  const guardians = useQuery({ queryKey: ['student', id, 'guardians'], queryFn: () => api.get<unknown>('/students/{id}/guardians', { path: { id } }).then(normGuardianLinks) });
  const siblings = useQuery({ queryKey: ['student', id, 'siblings'], queryFn: () => api.get<unknown>('/students/{id}/siblings', { path: { id } }).then(listOf<StudentSummary>) });
  return (
    <Stack>
      <Title order={2} size="h4">
        Parents and guardians
      </Title>
      <QueryState query={guardians}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>No parent or guardian linked.</EmptyState>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {list.map((l) => (
                <Card key={l.guardian.id} withBorder>
                  <Group justify="space-between" wrap="nowrap">
                    <Text component={Link} to={`/guardians/${l.guardian.id}`} fw={700} c="blue.8">
                      {l.guardian.fullName}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {l.relationship}
                    </Text>
                  </Group>
                  <Text size="sm">
                    <a href={`tel:${l.guardian.phonePrimary}`}>{displayPhone(l.guardian.phonePrimary)}</a>
                  </Text>
                  <Group gap={4} mt={6}>
                    {l.isPrimary && <Badge size="sm">Main contact</Badge>}
                    {l.isFeePayer && <Badge size="sm" color="teal">Pays fees</Badge>}
                    {l.canPickUp && <Badge size="sm" color="gray">Can pick up</Badge>}
                    {l.receivesSms && <Badge size="sm" color="grape">Gets SMS</Badge>}
                  </Group>
                </Card>
              ))}
            </SimpleGrid>
          )
        }
      </QueryState>
      <Title order={2} size="h4">
        Brothers and sisters in this school
      </Title>
      <QueryState query={siblings}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>None found (siblings are found through shared parents).</EmptyState>
          ) : (
            <Group>
              {list.map((s) => (
                <Button key={s.id} component={Link} to={`/students/${s.id}`} variant="light">
                  {s.fullName} · {s.className}
                </Button>
              ))}
            </Group>
          )
        }
      </QueryState>
    </Stack>
  );
}

function Medical({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['student', id, 'medical'], queryFn: () => api.get<StudentMedical>('/students/{id}/medical', { path: { id } }) });
  return (
    <QueryState query={query}>
      {(m) => (
        <Stack>
          {m.alertSummary && (
            <Alert color="red" title="Medical alert">
              {m.alertSummary}
            </Alert>
          )}
          <Card withBorder>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Field label="Blood group">{m.bloodGroup}</Field>
              <Field label="Allergies">{m.allergies}</Field>
              <Field label="Long-term conditions">{m.chronicConditions}</Field>
              <Field label="Medicines">{m.medicationNotes}</Field>
              <Field label="Special needs">{m.specialNeeds}</Field>
              <Field label="Doctor / clinic">{[m.doctorName, m.clinicName, displayPhone(m.clinicPhone)].filter((x) => x && x !== '—').join(', ')}</Field>
            </SimpleGrid>
            <Text size="xs" c="dimmed" mt="sm">
              Last updated {formatDateTime(m.updatedAt)}. Viewing this record is logged.
            </Text>
          </Card>
        </Stack>
      )}
    </QueryState>
  );
}

const DOC_LABELS: Record<string, string> = { birth_certificate: 'Birth certificate', previous_report: 'Previous school report', passport_photo: 'Passport photo', other: 'Other' };

function Documents({ id }: { id: string }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['student', id, 'documents'], queryFn: () => api.get<unknown>('/students/{id}/documents', { path: { id } }).then(listOf<StudentDocument>) });
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<string | null>('birth_certificate');
  const up = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file!);
      fd.append('docType', docType ?? 'other');
      return upload<StudentDocument>('POST', '/students/{id}/documents', { id }, fd);
    },
    onSuccess: () => {
      setFile(null);
      notifications.show({ color: 'green', message: 'Uploaded. It will be available after the virus check.' });
      void qc.invalidateQueries({ queryKey: ['student', id, 'documents'] });
    },
  });
  return (
    <Stack>
      <QueryState query={query}>
        {(docs) =>
          docs.length === 0 ? (
            <EmptyState>No documents yet.</EmptyState>
          ) : (
            <Table>
              <Table.Tbody>
                {docs.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td>{DOC_LABELS[d.docType] ?? d.docType}</Table.Td>
                    <Table.Td>{d.fileName}</Table.Td>
                    <Table.Td>{formatDate(d.uploadedAt)}</Table.Td>
                    <Table.Td>{d.scanStatus === 'clean' ? <Badge color="green">Ready</Badge> : d.scanStatus === 'pending' ? <Badge color="yellow">Checking for viruses</Badge> : <Badge color="red">Blocked</Badge>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )
        }
      </QueryState>
      <Can perm="student_documents:create">
        <Card withBorder>
          <Group align="flex-end" wrap="wrap">
            <Select label="Document type" data={Object.entries(DOC_LABELS).map(([value, label]) => ({ value, label }))} value={docType} onChange={setDocType} />
            <FileInput label="File (PDF, JPEG or PNG, up to 5 MB)" value={file} onChange={setFile} accept="application/pdf,image/jpeg,image/png" placeholder="Choose file" style={{ flex: 1, minWidth: 200 }} />
            <Button onClick={() => up.mutate()} disabled={!file} loading={up.isPending}>
              Upload
            </Button>
          </Group>
          <ProblemAlert error={up.error} />
        </Card>
      </Can>
    </Stack>
  );
}

function Enrolments({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['student', id, 'enrolments'], queryFn: () => api.get<unknown>('/students/{id}/enrolments', { path: { id } }).then(listOf<Enrolment>) });
  return (
    <QueryState query={query}>
      {(list) => (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Year</Table.Th>
              <Table.Th>Class</Table.Th>
              <Table.Th>Roll no.</Table.Th>
              <Table.Th>From</Table.Th>
              <Table.Th>To</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td>{e.academicYear}</Table.Td>
                <Table.Td>{e.className}</Table.Td>
                <Table.Td>{e.rollNumber}</Table.Td>
                <Table.Td>{formatDate(e.startDate)}</Table.Td>
                <Table.Td>{e.endDate ? formatDate(e.endDate) : 'Now'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </QueryState>
  );
}

function Finance({ id }: { id: string }) {
  const { can } = useAuth();
  const payments = useQuery({
    queryKey: ['payments', { studentId: id }],
    queryFn: () => api.get<Page<Payment>>('/payments', { query: { studentId: id, pageSize: 20 } }),
    enabled: can('payments:read'),
  });
  return (
    <Stack>
      <Card withBorder>
        <BalanceSummary studentId={id} />
      </Card>
      <Title order={2} size="h4">
        Account
      </Title>
      <LedgerTable studentId={id} />
      {can('payments:read') && (
        <>
          <Title order={2} size="h4">
            Receipts
          </Title>
          <QueryState query={payments}>
            {(p) =>
              p.data.length === 0 ? (
                <EmptyState>No payments yet.</EmptyState>
              ) : (
                <Table fz="sm">
                  <Table.Tbody>
                    {p.data.map((x) => (
                      <Table.Tr key={x.id}>
                        <Table.Td>
                          <Link to={`/finance/payments/${x.id}`}>{x.receiptNo}</Link>
                        </Table.Td>
                        <Table.Td>{formatDate(x.receivedAt)}</Table.Td>
                        <Table.Td>{PAYMENT_METHOD_LABELS[x.method ?? ''] ?? x.method}</Table.Td>
                        <Table.Td ta="right">
                          <Money value={x.amountPesewas} />
                        </Table.Td>
                        <Table.Td>{x.status === 'reversed' && <StatusBadge status="reversed" />}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )
            }
          </QueryState>
        </>
      )}
    </Stack>
  );
}

function Attendance({ classId }: { classId?: string }) {
  const query = useQuery({
    queryKey: ['attendance-summary', classId],
    queryFn: () => api.get<unknown>('/attendance/summary', { query: { classId } }).then(listOf<AttendanceSummaryRow>),
    enabled: Boolean(classId),
  });
  if (!classId) return <EmptyState>Not in a class.</EmptyState>;
  return (
    <QueryState query={query}>
      {(rows) => (
        <Stack gap="xs">
          {rows.map((r) => (
            <Text key={r.name}>
              {r.name}: <b>{r.ratePercent}%</b> attendance this term ({r.absent} absences, {r.late} late across the class).
            </Text>
          ))}
          <Text size="sm" c="dimmed">
            Per-child attendance appears here once the attendance summary returns individual rows.
          </Text>
        </Stack>
      )}
    </QueryState>
  );
}

function Incidents({ id }: { id: string }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['student', id, 'incidents'], queryFn: () => api.get<unknown>('/students/{id}/incidents', { path: { id } }).then(listOf<Incident>) });
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('General');
  const add = useMutation({
    mutationFn: () => api.post('/students/{id}/incidents', { path: { id }, body: { description, category, occurredOn: todayInAccra() } }),
    onSuccess: () => {
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['student', id, 'incidents'] });
    },
  });
  return (
    <Stack>
      <QueryState query={query}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>No incidents recorded.</EmptyState>
          ) : (
            list.map((i) => (
              <Card key={i.id} withBorder>
                <Text size="sm" fw={700}>
                  {formatDate(i.occurredOn)} · {i.category}
                </Text>
                <Text size="sm">{i.description}</Text>
                {i.actionTaken && <Text size="sm">Action: {i.actionTaken}</Text>}
                <Text size="xs" c="dimmed">
                  Recorded by {i.recordedBy}
                </Text>
              </Card>
            ))
          )
        }
      </QueryState>
      <Can perm="incidents:create">
        <Card withBorder>
          <Stack gap="xs">
            <TextInput label="Type" value={category} onChange={(e) => setCategory(e.currentTarget.value)} />
            <Textarea label="What happened?" value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
            <ProblemAlert error={add.error} />
            <Button onClick={() => add.mutate()} disabled={!description.trim()} loading={add.isPending} w="fit-content">
              Record incident
            </Button>
          </Stack>
        </Card>
      </Can>
    </Stack>
  );
}
