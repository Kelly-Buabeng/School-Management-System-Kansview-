import { Badge, Button, Card, Checkbox, FileInput, Group, Modal, NumberInput, Pagination, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { listOf, normAudit, normFeeItem } from '@/api/normalise';
import { api, upload } from '@/api/client';
import { useAcademicYears, useClasses } from '@/api/queries';
import type { AuditEvent, FeeItem, GradingScale, ListResponse, MessageTemplate, Page, Policies, Role, SchoolProfile, StaffMember, Term, UserAccount } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { ROLE_LABELS } from '@/auth/permissions';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { EmptyState, PageHeader, QueryState } from '@/components/ui';
import { displayPhone, formatDate, formatDateTime } from '@/lib/format';

const saved = () => notifications.show({ color: 'green', message: 'Saved.' });

// ---------------------------------------------------------------- staff
export function StaffPage() {
  const [params] = useSearchParams();
  const highlight = params.get('highlight');
  const query = useQuery({ queryKey: ['staff'], queryFn: () => api.get<unknown>('/staff').then(listOf<StaffMember>) });
  const [reveal, setReveal] = useState<StaffMember | null>(null);
  const [reason, setReason] = useState('');
  const [revealed, setRevealed] = useState<Record<string, { ghanaCardNumber: string; ssnitNumber: string }>>({});
  const doReveal = useMutation({
    mutationFn: (s: StaffMember) => api.post<{ ghanaCardNumber: string; ssnitNumber: string }>('/staff/{id}/sensitive/reveal', { path: { id: s.id }, body: { reason } }),
    onSuccess: (r, s) => {
      setRevealed((x) => ({ ...x, [s.id]: r }));
      setReveal(null);
      setReason('');
    },
  });
  return (
    <>
      <PageHeader title="Staff" />
      <QueryState query={query}>
        {(list) => (
          <div className="table-scroll">
            <Table miw={640} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Job</Table.Th>
                  <Table.Th>Phone</Table.Th>
                  <Table.Th>Classes</Table.Th>
                  <Can perm="staff_sensitive:reveal">
                    <Table.Th>Ghana Card / SSNIT</Table.Th>
                  </Can>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((s) => (
                  <Table.Tr key={s.id} bg={s.id === highlight ? 'yellow.0' : undefined}>
                    <Table.Td fw={600}>{s.fullName}</Table.Td>
                    <Table.Td>{s.jobTitle}</Table.Td>
                    <Table.Td>{s.phone ? <a href={`tel:${s.phone}`}>{displayPhone(s.phone)}</a> : '—'}</Table.Td>
                    <Table.Td>{(s.assignments ?? []).map((a) => a.className + (a.isClassTeacher ? ' (class teacher)' : '')).join(', ')}</Table.Td>
                    <Can perm="staff_sensitive:reveal">
                      <Table.Td>
                        {revealed[s.id] ? (
                          <Text size="xs">
                            {revealed[s.id]!.ghanaCardNumber} / {revealed[s.id]!.ssnitNumber}
                          </Text>
                        ) : (
                          <Group gap={4}>
                            <Text size="xs">
                              ••••{s.ghanaCardLast4} / ••••{s.ssnitLast4}
                            </Text>
                            <Button size="compact-xs" variant="default" onClick={() => setReveal(s)}>
                              Reveal
                            </Button>
                          </Group>
                        )}
                      </Table.Td>
                    </Can>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </QueryState>
      <Modal opened={Boolean(reveal)} onClose={() => setReveal(null)} title={`Reveal ID numbers for ${reveal?.fullName ?? ''}`}>
        <Stack>
          <Text size="sm">This is recorded in the audit log.</Text>
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <ProblemAlert error={doReveal.error} />
          <Button disabled={reason.trim().length < 5} loading={doReveal.isPending} onClick={() => reveal && doReveal.mutate(reveal)}>
            Reveal
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- settings
function SchoolProfileTab() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['school'], queryFn: () => api.get<SchoolProfile>('/settings/school') });
  const [form, setForm] = useState<SchoolProfile | null>(null);
  const [logo, setLogo] = useState<File | null>(null);
  useEffect(() => setForm(query.data ?? null), [query.data]);
  const save = useMutation({
    mutationFn: async () => {
      const { name, motto, address, phone, email } = form!;
      await api.patch('/settings/school', { body: { name, motto, address, phone, email } });
      if (logo) {
        const fd = new FormData();
        fd.append('file', logo);
        await upload('PUT', '/settings/school/logo', {}, fd);
      }
    },
    onSuccess: () => {
      saved();
      setLogo(null);
      void qc.invalidateQueries({ queryKey: ['school'] });
    },
  });
  if (!form) return <QueryState query={query}>{() => null}</QueryState>;
  const f = (k: keyof SchoolProfile) => ({ value: String(form[k] ?? ''), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.currentTarget.value }) });
  return (
    <Card withBorder maw={720}>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="School name" {...f('name')} />
        <TextInput label="School code (used in student IDs)" value={form.schoolCode} readOnly description="Locked after the first student is admitted." />
        <TextInput label="Motto" {...f('motto')} />
        <TextInput label="Phone" {...f('phone')} />
        <TextInput label="Email" {...f('email')} />
        <TextInput label="Address" {...f('address')} />
        <FileInput label="Logo (PNG or JPEG)" accept="image/png,image/jpeg" value={logo} onChange={setLogo} clearable />
      </SimpleGrid>
      <ProblemAlert error={save.error} />
      <Button mt="md" onClick={() => save.mutate()} loading={save.isPending}>
        Save profile
      </Button>
    </Card>
  );
}

function TermRow({ t }: { t: Term }) {
  const qc = useQueryClient();
  const [start, setStart] = useState(t.startDate);
  const [end, setEnd] = useState(t.endDate);
  const save = useMutation({ mutationFn: () => api.patch('/terms/{id}', { path: { id: t.id }, body: { startDate: start, endDate: end } }), onSuccess: () => { saved(); void qc.invalidateQueries({ queryKey: ['academic-years'] }); }, onError: (e) => notifications.show(notifyError(e)) });
  return (
    <Table.Tr>
      <Table.Td>
        {t.name} {t.isCurrent && <Badge size="xs">Current</Badge>}
      </Table.Td>
      <Table.Td>
        <TextInput type="date" size="xs" aria-label={`${t.name} starts`} value={start} onChange={(e) => setStart(e.currentTarget.value)} />
      </Table.Td>
      <Table.Td>
        <TextInput type="date" size="xs" aria-label={`${t.name} ends`} value={end} onChange={(e) => setEnd(e.currentTarget.value)} />
      </Table.Td>
      <Table.Td>
        <Button size="compact-xs" disabled={start === t.startDate && end === t.endDate} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function TermsTab() {
  const years = useAcademicYears();
  return (
    <QueryState query={years}>
      {(list) => (
        <Stack maw={720}>
          {list.map((y) => (
            <Card key={y.id} withBorder>
              <Text fw={700} mb="xs">
                {y.name} {y.isCurrent && <Badge>Current year</Badge>}
              </Text>
              <Table fz="sm">
                <Table.Tbody>
                  {y.terms.map((t) => (
                    <TermRow key={t.id} t={t} />
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          ))}
        </Stack>
      )}
    </QueryState>
  );
}

function ClassesTab() {
  const qc = useQueryClient();
  const classes = useClasses();
  const [cap, setCap] = useState<Record<string, number | string>>({});
  const save = useMutation({ mutationFn: ({ id, capacity }: { id: string; capacity: number }) => api.patch('/classes/{id}', { path: { id }, body: { capacity } }), onSuccess: () => { saved(); void qc.invalidateQueries({ queryKey: ['classes'] }); }, onError: (e) => notifications.show(notifyError(e)) });
  return (
    <QueryState query={classes}>
      {(list) => (
        <Table maw={600} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Class</Table.Th>
              <Table.Th>Enrolled</Table.Th>
              <Table.Th>Capacity</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((c) => (
              <Table.Tr key={c.id}>
                <Table.Td>{c.name}</Table.Td>
                <Table.Td>{c.enrolledCount}</Table.Td>
                <Table.Td>
                  <NumberInput size="xs" w={90} min={1} allowDecimal={false} aria-label={`Capacity of ${c.name}`} value={cap[c.id] ?? c.capacity} onChange={(v) => setCap((x) => ({ ...x, [c.id]: v }))} />
                </Table.Td>
                <Table.Td>
                  <Button size="compact-xs" disabled={cap[c.id] === undefined || Number(cap[c.id]) === c.capacity} onClick={() => save.mutate({ id: c.id, capacity: Number(cap[c.id]) })}>
                    Save
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </QueryState>
  );
}

function GradingTab() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['grading'], queryFn: () => api.get<unknown>('/grading-scales').then(listOf<GradingScale>) });
  const [gs, setGs] = useState<GradingScale | null>(null);
  useEffect(() => setGs(query.data?.[0] ?? null), [query.data]);
  const save = useMutation({ mutationFn: () => api.put('/grading-scales/{id}', { path: { id: gs!.id }, body: { classWeightPercent: gs!.classWeightPercent, examWeightPercent: gs!.examWeightPercent, bands: gs!.bands } }), onSuccess: () => { saved(); void qc.invalidateQueries({ queryKey: ['grading'] }); } });
  if (!gs) return <QueryState query={query}>{() => <EmptyState>No grading scale.</EmptyState>}</QueryState>;
  return (
    <Card withBorder maw={640}>
      <Group mb="sm">
        <NumberInput label="Class score weight (%)" value={gs.classWeightPercent} min={0} max={100} allowDecimal={false} onChange={(v) => setGs({ ...gs, classWeightPercent: Number(v) })} />
        <NumberInput label="Exam weight (%)" value={gs.examWeightPercent} min={0} max={100} allowDecimal={false} onChange={(v) => setGs({ ...gs, examWeightPercent: Number(v) })} />
      </Group>
      <Table fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Grade</Table.Th>
            <Table.Th>From</Table.Th>
            <Table.Th>To</Table.Th>
            <Table.Th>Remark</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {gs.bands.map((b, i) => (
            <Table.Tr key={b.grade}>
              <Table.Td>{b.grade}</Table.Td>
              <Table.Td>
                <NumberInput size="xs" w={70} aria-label={`Grade ${b.grade} from`} value={b.minScore} onChange={(v) => setGs({ ...gs, bands: gs.bands.map((x, j) => (j === i ? { ...x, minScore: Number(v) } : x)) })} />
              </Table.Td>
              <Table.Td>{b.maxScore}</Table.Td>
              <Table.Td>
                <TextInput size="xs" aria-label={`Grade ${b.grade} remark`} value={b.remark} onChange={(e) => { const v = e.currentTarget.value; setGs({ ...gs, bands: gs.bands.map((x, j) => (j === i ? { ...x, remark: v } : x)) }); }} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <ProblemAlert error={save.error} />
      <Button mt="sm" onClick={() => save.mutate()} loading={save.isPending}>
        Save grading scale
      </Button>
    </Card>
  );
}

function FeeItemsTab() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['fee-items'], queryFn: () => api.get<unknown>('/fee-items').then((r) => listOf<Record<string, unknown>>(r).map(normFeeItem)) });
  const [name, setName] = useState('');
  const [optional, setOptional] = useState(false);
  const add = useMutation({ mutationFn: () => api.post('/fee-items', { body: { name, optional, category: 'other' } }), onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['fee-items'] }); } });
  return (
    <Stack maw={600}>
      <QueryState query={query}>
        {(list) => (
          <Table fz="sm">
            <Table.Tbody>
              {list.map((i) => (
                <Table.Tr key={i.id}>
                  <Table.Td>{i.priority}</Table.Td>
                  <Table.Td>{i.name}</Table.Td>
                  <Table.Td>{i.optional ? 'Optional' : 'Everyone'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </QueryState>
      <Can perm="fee_structures:create" fallback={<Text size="sm" c="dimmed">The bursar adds fee items.</Text>}>
        <Group align="flex-end">
          <TextInput label="New fee item" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Checkbox label="Optional" checked={optional} onChange={(e) => setOptional(e.currentTarget.checked)} mb={8} />
          <Button disabled={!name.trim()} onClick={() => add.mutate()} loading={add.isPending}>
            Add
          </Button>
        </Group>
        <ProblemAlert error={add.error} />
      </Can>
      <Text size="xs" c="dimmed">Payments are applied to items in this order (1 first).</Text>
    </Stack>
  );
}

function TemplateRow({ t }: { t: MessageTemplate }) {
  const qc = useQueryClient();
  const [body, setBody] = useState(t.body);
  const save = useMutation({ mutationFn: () => api.patch('/message-templates/{id}', { path: { id: t.id }, body: { body } }), onSuccess: () => { saved(); void qc.invalidateQueries({ queryKey: ['templates'] }); } });
  return (
    <Card withBorder>
      <Text fw={600}>{t.name}</Text>
      <Textarea value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={2} aria-label={`Template ${t.name}`} />
      <ProblemAlert error={save.error} />
      <Button mt="xs" size="xs" disabled={body === t.body} loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
    </Card>
  );
}

function TemplatesTab() {
  const query = useQuery({ queryKey: ['templates'], queryFn: () => api.get<unknown>('/message-templates').then(listOf<MessageTemplate>) });
  return (
    <Stack maw={720}>
      <Text size="sm">Allowed placeholders: {'{guardian_name}'}, {'{student_name}'}, {'{balance}'}, {'{due_date}'}, {'{date}'}, {'{time}'}, {'{reason}'}</Text>
      <QueryState query={query}>{(list) => list.map((t) => <TemplateRow key={t.id} t={t} />)}</QueryState>
    </Stack>
  );
}

function PoliciesTab() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['policies'], queryFn: () => api.get<Policies>('/settings/policies') });
  const [p, setP] = useState<Policies | null>(null);
  useEffect(() => setP(query.data ?? null), [query.data]);
  const save = useMutation({ mutationFn: () => api.patch('/settings/policies', { body: { ...p, version: undefined } }), onSuccess: () => { saved(); void qc.invalidateQueries({ queryKey: ['policies'] }); } });
  if (!p) return <QueryState query={query}>{() => null}</QueryState>;
  return (
    <Card withBorder maw={640}>
      <Stack>
        <Select
          label="Promotion when a student owes fees"
          data={[{ value: 'off', label: 'Do not check fees' }, { value: 'warn', label: 'Highlight, but allow' }, { value: 'block', label: 'Block unless a reason is given' }]}
          value={p.arrearsPromotionPolicy}
          onChange={(v) => v && setP({ ...p, arrearsPromotionPolicy: v as Policies['arrearsPromotionPolicy'] })}
          allowDeselect={false}
        />
        <Switch label="Send an SMS to parents when a child is marked absent" checked={p.absenceSmsEnabled} onChange={(e) => setP({ ...p, absenceSmsEnabled: e.currentTarget.checked })} />
        <Group>
          <TextInput type="time" label="No SMS after" value={p.quietHoursStart} onChange={(e) => setP({ ...p, quietHoursStart: e.currentTarget.value })} />
          <TextInput type="time" label="…until" value={p.quietHoursEnd} onChange={(e) => setP({ ...p, quietHoursEnd: e.currentTarget.value })} />
        </Group>
        <NumberInput label="Bulk messages above this many parents need approval" value={p.bulkApprovalThreshold} min={1} allowDecimal={false} onChange={(v) => setP({ ...p, bulkApprovalThreshold: Number(v) })} />
        <NumberInput label="Days allowed to undo a promotion" value={p.promotionUndoDays} min={0} max={60} allowDecimal={false} onChange={(v) => setP({ ...p, promotionUndoDays: Number(v) })} />
        <ProblemAlert error={save.error} />
        <Button w="fit-content" onClick={() => save.mutate()} loading={save.isPending}>
          Save policies
        </Button>
      </Stack>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs defaultValue="school" keepMounted={false}>
        <Tabs.List mb="md" style={{ overflowX: 'auto', flexWrap: 'nowrap' }}>
          <Tabs.Tab value="school">School profile</Tabs.Tab>
          <Tabs.Tab value="terms">Terms calendar</Tabs.Tab>
          <Tabs.Tab value="classes">Classes</Tabs.Tab>
          <Tabs.Tab value="grading">Grading scale</Tabs.Tab>
          <Tabs.Tab value="fees">Fee items</Tabs.Tab>
          <Tabs.Tab value="templates">SMS templates</Tabs.Tab>
          <Tabs.Tab value="policies">Policies</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="school"><SchoolProfileTab /></Tabs.Panel>
        <Tabs.Panel value="terms"><TermsTab /></Tabs.Panel>
        <Tabs.Panel value="classes"><ClassesTab /></Tabs.Panel>
        <Tabs.Panel value="grading"><GradingTab /></Tabs.Panel>
        <Tabs.Panel value="fees"><FeeItemsTab /></Tabs.Panel>
        <Tabs.Panel value="templates"><TemplatesTab /></Tabs.Panel>
        <Tabs.Panel value="policies"><PoliciesTab /></Tabs.Panel>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- users
const ROLES = Object.keys(ROLE_LABELS) as Role[];

export function UsersPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['users'], queryFn: () => api.get<unknown>('/users', { query: { pageSize: 100 } }).then(listOf<UserAccount>) });
  const [creating, setCreating] = useState(false);
  const [nu, setNu] = useState({ username: '', fullName: '', roles: [] as Role[] });
  const [temp, setTemp] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({
    mutationFn: () => api.post<{ temporaryPassword: string }>('/users', { body: nu }),
    onSuccess: (r) => {
      setTemp(r.temporaryPassword);
      setCreating(false);
      setNu({ username: '', fullName: '', roles: [] });
      refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: 'force-logout' | 'unlock' | 'reset-mfa' | 'reset-password' | 'disable' | 'enable' }) => {
      if (act === 'disable' || act === 'enable') return api.patch('/users/{id}', { path: { id }, body: { status: act === 'disable' ? 'disabled' : 'active' } });
      const path = { 'force-logout': '/users/{id}/force-logout', unlock: '/users/{id}/unlock', 'reset-mfa': '/users/{id}/reset-mfa', 'reset-password': '/users/{id}/reset-password' } as const;
      return api.post<{ temporaryPassword?: string } | undefined>(path[act], { path: { id } });
    },
    onSuccess: (r) => {
      const t = (r as { temporaryPassword?: string } | undefined)?.temporaryPassword;
      if (t) setTemp(t);
      else notifications.show({ color: 'green', message: 'Done.' });
      refresh();
    },
    onError: (e) => notifications.show(notifyError(e)),
  });
  const confirm = (u: UserAccount, act: Parameters<typeof action.mutate>[0]['act'], label: string) =>
    modals.openConfirmModal({ title: `${label} for ${u.fullName}?`, labels: { confirm: label, cancel: 'Cancel' }, onConfirm: () => action.mutate({ id: u.id, act }) });
  return (
    <>
      <PageHeader title="Users" subtitle="Who can sign in and what they can do." actions={<Button onClick={() => setCreating(true)}>Add user</Button>} />
      <QueryState query={query}>
        {(list) => (
          <div className="table-scroll">
            <Table miw={760} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Username</Table.Th>
                  <Table.Th>Roles</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last sign-in</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((u) => (
                  <Table.Tr key={u.id}>
                    <Table.Td fw={600}>{u.fullName}</Table.Td>
                    <Table.Td>{u.username}</Table.Td>
                    <Table.Td>{u.roles.map((r) => ROLE_LABELS[r]).join(', ')}</Table.Td>
                    <Table.Td>
                      <Badge color={u.status === 'active' ? 'green' : u.status === 'locked' ? 'red' : 'gray'} variant="default">
                        {u.status}
                      </Badge>
                      {u.mfaEnabled && <Badge ml={4} variant="outline" size="xs">MFA</Badge>}
                    </Table.Td>
                    <Table.Td>{formatDateTime(u.lastLoginAt)}</Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        w={150}
                        placeholder="Actions…"
                        aria-label={`Actions for ${u.fullName}`}
                        value={null}
                        data={[
                          { value: 'reset-password', label: 'Reset password' },
                          { value: 'reset-mfa', label: 'Reset MFA' },
                          { value: 'force-logout', label: 'Sign out everywhere' },
                          ...(u.status === 'locked' ? [{ value: 'unlock', label: 'Unlock' }] : []),
                          u.status === 'disabled' ? { value: 'enable', label: 'Turn on account' } : { value: 'disable', label: 'Turn off account' },
                        ]}
                        onChange={(v) => v && confirm(u, v as 'unlock', ({ 'reset-password': 'Reset password', 'reset-mfa': 'Reset MFA', 'force-logout': 'Sign out everywhere', unlock: 'Unlock', enable: 'Turn on', disable: 'Turn off' } as Record<string, string>)[v]!)}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </QueryState>
      <Modal opened={creating} onClose={() => setCreating(false)} title="Add a user">
        <Stack>
          <TextInput label="Full name" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.currentTarget.value })} />
          <TextInput label="Username" description="Lower-case letters and numbers, e.g. akua.f" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.currentTarget.value.toLowerCase() })} />
          <Checkbox.Group label="Roles" value={nu.roles} onChange={(v) => setNu({ ...nu, roles: v as Role[] })}>
            <Stack gap={4} mt={4}>
              {ROLES.map((r) => (
                <Checkbox key={r} value={r} label={ROLE_LABELS[r]} />
              ))}
            </Stack>
          </Checkbox.Group>
          <Text size="xs" c="dimmed">Administrators and bursars must set up a phone authenticator at first sign-in.</Text>
          <ProblemAlert error={create.error} />
          <Button onClick={() => create.mutate()} loading={create.isPending}>
            Create user
          </Button>
        </Stack>
      </Modal>
      <Modal opened={Boolean(temp)} onClose={() => setTemp(null)} title="Temporary password">
        <Text>Give this to the person privately. They must change it when they first sign in.</Text>
        <Text fz="xl" fw={700} my="md">
          {temp}
        </Text>
        <Button onClick={() => setTemp(null)}>I have written it down</Button>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- audit
export function AuditPage() {
  const [action, setAction] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 300);
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['audit', action, debounced, page], queryFn: () => api.get<Page<Record<string, unknown>>>('/audit-events', { query: { action, q: debounced, page, pageSize: 50 } }).then((p): Page<AuditEvent> => ({ ...p, data: listOf<Record<string, unknown>>(p).map(normAudit) })), placeholderData: keepPreviousData });
  const verify = useMutation({ mutationFn: () => api.post<{ intact: boolean; firstBrokenEventId?: string }>('/audit-events/verify'), onError: (e) => notifications.show(notifyError(e)) });
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every sensitive view and every change, with who and when. Entries cannot be edited."
        actions={
          <Button variant="default" onClick={() => verify.mutate()} loading={verify.isPending}>
            Check the log has not been tampered with
          </Button>
        }
      />
      {verify.data && (
        <Text c={verify.data.intact ? 'green.8' : 'red.8'} fw={600} mb="sm">
          {verify.data.intact ? 'The log is intact.' : `The log is broken at event ${verify.data.firstBrokenEventId}. Tell the administrator.`}
        </Text>
      )}
      <Group mb="md" wrap="wrap">
        <Select label="Action" clearable placeholder="All" data={['login', 'login_failed', 'create', 'update', 'view', 'emergency_view', 'reveal_sensitive', 'export', 'approve', 'reverse', 'archive']} value={action} onChange={(v) => { setAction(v); setPage(1); }} />
        <TextInput label="Search" placeholder="Name or words" value={q} onChange={(e) => { setQ(e.currentTarget.value); setPage(1); }} />
      </Group>
      <QueryState query={query}>
        {(d) =>
          d.data.length === 0 ? (
            <EmptyState>No events.</EmptyState>
          ) : (
            <>
              <div className="table-scroll">
                <Table miw={720} fz="sm" striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>When</Table.Th>
                      <Table.Th>Who</Table.Th>
                      <Table.Th>Action</Table.Th>
                      <Table.Th>What</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.data.map((e) => (
                      <Table.Tr key={e.id}>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.at)}</Table.Td>
                        <Table.Td>{e.actorName}</Table.Td>
                        <Table.Td>
                          <Badge variant="default" color={e.action.includes('fail') ? 'red' : e.action === 'reveal_sensitive' || e.action === 'emergency_view' ? 'grape' : 'gray'}>
                            {e.action.replace(/_/g, ' ')}
                          </Badge>
                        </Table.Td>
                        <Table.Td>{e.summary}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
              {d.total > 50 && <Pagination mt="md" total={Math.ceil(d.total / 50)} value={page} onChange={setPage} />}
            </>
          )
        }
      </QueryState>
      <Text size="xs" c="dimmed" mt="sm">
        Showing dates in Ghana time. Oldest kept entry: {formatDate(query.data?.data.at(-1)?.at)}.
      </Text>
    </>
  );
}
