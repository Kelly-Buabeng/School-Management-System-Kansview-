import { zodResolver } from '@hookform/resolvers/zod';
import { ActionIcon, Alert, Badge, Button, Card, Checkbox, Group, Loader, Radio, Select, SimpleGrid, Stack, Stepper, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useFieldArray, useForm, type FieldPath } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { normaliseGhanaPhone } from '@sms/shared';
import { api, ApiError } from '@/api/client';
import { classOptions, useClasses } from '@/api/queries';
import type { AdmitStudentRequest, DuplicateCandidate, Guardian, Page, Student } from '@/api/types';
import { ProblemAlert } from '@/components/ProblemAlert';
import { PageHeader } from '@/components/ui';
import { displayPhone, formatDate, todayInAccra } from '@/lib/format';
import { DuplicateDialog } from './DuplicateDialog';

const phoneOk = (v: string | undefined) => !v || normaliseGhanaPhone(v) !== null;
const optional = z.string().trim().optional();

const guardianSchema = z
  .object({
    mode: z.enum(['existing', 'new']),
    guardianId: z.string().optional(),
    existingLabel: z.string().optional(),
    title: optional,
    firstName: optional,
    lastName: optional,
    phonePrimary: optional,
    email: z.union([z.literal(''), z.email('Enter a valid email address')]).optional(),
    occupation: optional,
    ghanaCardNumber: z.union([z.literal(''), z.string().regex(/^GHA-\d{9}-\d$/, 'Format is GHA-123456789-0')]).optional(),
    relationship: z.string().trim().min(1, 'Say how they are related (e.g. Mother)'),
    isPrimary: z.boolean(),
    isFeePayer: z.boolean(),
    canPickUp: z.boolean(),
  })
  .superRefine((g, ctx) => {
    if (g.mode === 'new') {
      if (!g.firstName) ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Enter the first name' });
      if (!g.lastName) ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Enter the surname' });
      if (!g.phonePrimary) ctx.addIssue({ code: 'custom', path: ['phonePrimary'], message: 'Enter a phone number' });
      else if (!phoneOk(g.phonePrimary)) ctx.addIssue({ code: 'custom', path: ['phonePrimary'], message: 'Enter a Ghana number, e.g. 024 000 0123' });
    }
  });

const schema = z.object({
  firstName: z.string().trim().min(1, 'Enter the first name').max(80),
  middleNames: optional,
  lastName: z.string().trim().min(1, 'Enter the surname').max(80),
  preferredName: optional,
  dateOfBirth: z
    .string()
    .min(1, 'Enter the date of birth')
    .refine((v) => v < todayInAccra(), 'Date of birth must be in the past'),
  gender: z.enum(['male', 'female'], { message: 'Choose one' }),
  classId: z.string({ message: 'Choose a class' }).min(1, 'Choose a class'),
  admissionDate: z.string().min(1, 'Enter the admission date'),
  homeAddress: optional,
  previousSchool: optional,
  birthCertNo: optional,
  religion: optional,
  guardians: z
    .array(guardianSchema)
    .min(1, 'Add at least one parent or guardian')
    .refine((gs) => gs.some((g) => g.isPrimary), 'Tick “Main contact” for one parent or guardian'),
  medical: z.object({
    bloodGroup: optional,
    allergies: optional,
    chronicConditions: optional,
    medicationNotes: optional,
    specialNeeds: optional,
    alertSummary: z.string().trim().max(200, 'Keep the alert under 200 characters').optional(),
    doctorName: optional,
    clinicName: optional,
    clinicPhone: z.string().trim().optional().refine(phoneOk, 'Enter a Ghana number'),
  }),
  contacts: z.array(
    z.object({
      guardianId: z.string().optional(),
      name: z.string().trim().min(1, 'Enter a name'),
      relationship: z.string().trim().min(1, 'Enter the relationship'),
      phone: z.string().trim().min(1, 'Enter a phone number').refine(phoneOk, 'Enter a Ghana number'),
    }),
  ),
});
type FormValues = z.infer<typeof schema>;

const STEP_FIELDS: FieldPath<FormValues>[][] = [
  ['firstName', 'middleNames', 'lastName', 'dateOfBirth', 'gender', 'classId', 'admissionDate'],
  ['guardians'],
  ['medical'],
  ['contacts'],
  [],
];

function GuardianSearch({ onPick }: { onPick: (g: Guardian) => void }) {
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q.trim(), 300);
  const isPhone = /^[+\d\s]{4,}$/.test(debounced);
  const query = useQuery({
    queryKey: ['guardians', debounced],
    queryFn: ({ signal }) => api.get<Page<Guardian>>('/guardians', { query: isPhone ? { phone: debounced, pageSize: 8 } : { q: debounced, pageSize: 8 }, signal }),
    enabled: debounced.length >= 3,
  });
  return (
    <Stack gap="xs">
      <TextInput label="Find an existing parent (name or phone)" description="If a brother or sister is already in the school, link the same parent so the children are connected." value={q} onChange={(e) => setQ(e.currentTarget.value)} rightSection={query.isFetching ? <Loader size="xs" /> : null} />
      <ProblemAlert error={query.error} />
      {query.data?.data.map((g) => (
        <Card key={g.id} withBorder p="xs">
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600} size="sm">
                {g.fullName} · {displayPhone(g.phonePrimary)}
              </Text>
              <Text size="xs" c="dimmed">
                Children: {g.children?.map((c) => `${c.fullName} (${c.className ?? '—'})`).join(', ') || 'none'}
              </Text>
            </div>
            <Button size="xs" variant="default" onClick={() => onPick(g)}>
              Link this parent
            </Button>
          </Group>
        </Card>
      ))}
      {debounced.length >= 3 && query.data?.data.length === 0 && (
        <Text size="sm" c="dimmed">
          No existing parent found. Add a new one below.
        </Text>
      )}
    </Stack>
  );
}

export default function AdmissionWizard() {
  const navigate = useNavigate();
  const classes = useClasses();
  const [step, setStep] = useState(0);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      firstName: '',
      lastName: '',
      dateOfBirth: '',
      admissionDate: todayInAccra(),
      classId: '',
      guardians: [],
      medical: {},
      contacts: [],
    },
  });
  const { register, control, formState, getValues, setValue } = form;
  const errors = formState.errors;
  const guardians = useFieldArray({ control, name: 'guardians' });
  const contacts = useFieldArray({ control, name: 'contacts' });

  const admit = useMutation({
    mutationFn: (override?: string) => api.post<Student>('/students', { body: toRequest(getValues(), override) }),
    onSuccess: (s) => {
      notifications.show({ color: 'green', title: 'Student admitted', message: `${s.fullName} — student ID ${s.studentCode}` });
      navigate(`/students/${s.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STUDENT_POSSIBLE_DUPLICATE') {
        const meta = (e.problem.meta ?? {}) as { candidates?: DuplicateCandidate[]; matches?: DuplicateCandidate[] };
        setDuplicates(meta.candidates ?? meta.matches ?? []);
      } else if (e instanceof ApiError) {
        for (const [field, message] of Object.entries(e.fieldErrors())) form.setError(field as FieldPath<FormValues>, { message });
      }
    },
  });

  const next = async () => {
    const ok = await form.trigger(STEP_FIELDS[step]);
    if (!ok) return;
    if (step === 2 && getValues('contacts').length === 0) {
      // Pre-fill emergency contacts from the parents, main contact first.
      const gs = [...getValues('guardians')].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      setValue(
        'contacts',
        gs.map((g) => ({ guardianId: g.guardianId, name: g.mode === 'existing' ? (g.existingLabel ?? '') : `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim(), relationship: g.relationship, phone: g.mode === 'existing' ? (g.phonePrimary ?? '') : (g.phonePrimary ?? '') })),
      );
    }
    setStep((s) => s + 1);
  };

  const addNew = () => guardians.append({ mode: 'new', firstName: '', lastName: '', phonePrimary: '', relationship: '', isPrimary: guardians.fields.length === 0, isFeePayer: guardians.fields.length === 0, canPickUp: true });
  const addExisting = (g: Guardian) => {
    if (getValues('guardians').some((x) => x.guardianId === g.id)) return;
    guardians.append({ mode: 'existing', guardianId: g.id, existingLabel: g.fullName, phonePrimary: g.phonePrimary, relationship: '', isPrimary: guardians.fields.length === 0, isFeePayer: guardians.fields.length === 0, canPickUp: true });
  };

  const v = form.watch();
  const className = classes.data?.find((c) => c.id === v.classId)?.name;

  return (
    <>
      <PageHeader title="Admit a student" subtitle="Five short steps. Nothing is saved until you press “Admit student” at the end." />
      <Stepper active={step} onStepClick={(s) => s < step && setStep(s)} size="sm" mb="lg" allowNextStepsSelect={false} wrap>
        <Stepper.Step label="Child" />
        <Stepper.Step label="Parents" />
        <Stepper.Step label="Medical" />
        <Stepper.Step label="Emergency contacts" />
        <Stepper.Step label="Check and admit" />
      </Stepper>
      <form onSubmit={(e) => e.preventDefault()} noValidate>
        {step === 0 && (
          <Card withBorder>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="First name" withAsterisk {...register('firstName')} error={errors.firstName?.message} />
              <TextInput label="Other names (optional)" {...register('middleNames')} />
              <TextInput label="Surname" withAsterisk {...register('lastName')} error={errors.lastName?.message} />
              <TextInput label="Known as (optional)" {...register('preferredName')} />
              <TextInput label="Date of birth" type="date" withAsterisk {...register('dateOfBirth')} error={errors.dateOfBirth?.message} max={todayInAccra()} />
              <Controller
                control={control}
                name="gender"
                render={({ field }) => (
                  <Radio.Group label="Gender" withAsterisk value={field.value ?? ''} onChange={field.onChange} error={errors.gender?.message}>
                    <Group mt={6}>
                      <Radio value="female" label="Female" />
                      <Radio value="male" label="Male" />
                    </Group>
                  </Radio.Group>
                )}
              />
              <Controller
                control={control}
                name="classId"
                render={({ field }) => (
                  <Select
                    label="Class"
                    withAsterisk
                    data={(classes.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.enrolledCount}/${c.capacity})`, disabled: c.enrolledCount >= c.capacity }))}
                    value={field.value || null}
                    onChange={(x) => field.onChange(x ?? '')}
                    error={errors.classId?.message}
                    placeholder={classes.isLoading ? 'Loading classes…' : 'Choose'}
                    searchable
                    description="Full classes cannot be chosen."
                  />
                )}
              />
              <TextInput label="Admission date" type="date" withAsterisk {...register('admissionDate')} error={errors.admissionDate?.message} />
              <TextInput label="Previous school (optional)" {...register('previousSchool')} />
              <TextInput label="Birth certificate number (optional)" {...register('birthCertNo')} />
              <TextInput label="Religion (optional)" {...register('religion')} />
              <Textarea label="Home address (optional)" {...register('homeAddress')} autosize minRows={1} />
            </SimpleGrid>
            <Text size="xs" c="dimmed" mt="sm">
              The student ID is created automatically when you admit, and never changes.
            </Text>
          </Card>
        )}

        {step === 1 && (
          <Stack>
            <Card withBorder>
              <GuardianSearch onPick={addExisting} />
            </Card>
            {guardians.fields.map((f, i) => {
              const ge = errors.guardians?.[i];
              return (
                <Card key={f.id} withBorder>
                  <Group justify="space-between" mb="xs">
                    <Title order={3} size="h5">
                      {f.mode === 'existing' ? `Existing parent: ${f.existingLabel}` : 'New parent or guardian'}
                    </Title>
                    <Button size="xs" variant="subtle" color="red" onClick={() => guardians.remove(i)}>
                      Remove
                    </Button>
                  </Group>
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    {f.mode === 'new' && (
                      <>
                        <TextInput label="First name" withAsterisk {...register(`guardians.${i}.firstName`)} error={ge?.firstName?.message} />
                        <TextInput label="Surname" withAsterisk {...register(`guardians.${i}.lastName`)} error={ge?.lastName?.message} />
                        <TextInput label="Phone" withAsterisk type="tel" placeholder="024 000 0123" {...register(`guardians.${i}.phonePrimary`)} error={ge?.phonePrimary?.message} />
                        <TextInput label="Email (optional)" type="email" {...register(`guardians.${i}.email`)} error={ge?.email?.message} />
                        <TextInput label="Occupation (optional)" {...register(`guardians.${i}.occupation`)} />
                        <TextInput label="Ghana Card (optional)" placeholder="GHA-123456789-0" description="Stored encrypted; shown masked afterwards." {...register(`guardians.${i}.ghanaCardNumber`)} error={ge?.ghanaCardNumber?.message} />
                      </>
                    )}
                    <TextInput label="Relationship to child" withAsterisk placeholder="Mother, Father, Aunt…" {...register(`guardians.${i}.relationship`)} error={ge?.relationship?.message} />
                  </SimpleGrid>
                  <Group mt="sm" gap="lg">
                    <Checkbox label="Main contact" {...register(`guardians.${i}.isPrimary`)} />
                    <Checkbox label="Pays the fees" {...register(`guardians.${i}.isFeePayer`)} />
                    <Checkbox label="Can pick up the child" {...register(`guardians.${i}.canPickUp`)} />
                  </Group>
                </Card>
              );
            })}
            {(errors.guardians?.message || errors.guardians?.root?.message) && (
              <Alert color="red" role="alert">
                {errors.guardians?.message ?? errors.guardians?.root?.message}
              </Alert>
            )}
            <Button variant="default" onClick={addNew} w="fit-content">
              + Add a new parent or guardian
            </Button>
          </Stack>
        )}

        {step === 2 && (
          <Card withBorder>
            <Text size="sm" mb="sm">
              All optional. Anything in the alert box shows in red on the Emergency View.
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Controller
                control={control}
                name="medical.bloodGroup"
                render={({ field }) => <Select label="Blood group" data={['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']} value={field.value ?? null} onChange={(x) => field.onChange(x ?? undefined)} clearable />}
              />
              <TextInput label="Medical alert (short, shown in red)" placeholder="e.g. Severe peanut allergy — EpiPen in office" {...register('medical.alertSummary')} error={errors.medical?.alertSummary?.message} />
              <Textarea label="Allergies" {...register('medical.allergies')} autosize minRows={2} />
              <Textarea label="Long-term conditions" {...register('medical.chronicConditions')} autosize minRows={2} />
              <Textarea label="Medicines and where they are kept" {...register('medical.medicationNotes')} autosize minRows={2} />
              <Textarea label="Special needs" {...register('medical.specialNeeds')} autosize minRows={2} />
              <TextInput label="Doctor's name" {...register('medical.doctorName')} />
              <TextInput label="Clinic or hospital" {...register('medical.clinicName')} />
              <TextInput label="Clinic phone" type="tel" {...register('medical.clinicPhone')} error={errors.medical?.clinicPhone?.message} />
            </SimpleGrid>
          </Card>
        )}

        {step === 3 && (
          <Stack>
            <Text size="sm">In an emergency, staff call these people in this order. Use the arrows to change the order.</Text>
            {contacts.fields.map((f, i) => (
              <Card key={f.id} withBorder>
                <Group align="flex-start" wrap="nowrap">
                  <Badge size="lg" circle>
                    {i + 1}
                  </Badge>
                  <SimpleGrid cols={{ base: 1, sm: 3 }} style={{ flex: 1 }}>
                    <TextInput label="Name" {...register(`contacts.${i}.name`)} error={errors.contacts?.[i]?.name?.message} />
                    <TextInput label="Relationship" {...register(`contacts.${i}.relationship`)} error={errors.contacts?.[i]?.relationship?.message} />
                    <TextInput label="Phone" type="tel" {...register(`contacts.${i}.phone`)} error={errors.contacts?.[i]?.phone?.message} />
                  </SimpleGrid>
                  <Stack gap={2}>
                    <ActionIcon variant="default" aria-label={`Move contact ${i + 1} up`} disabled={i === 0} onClick={() => contacts.move(i, i - 1)}>
                      ↑
                    </ActionIcon>
                    <ActionIcon variant="default" aria-label={`Move contact ${i + 1} down`} disabled={i === contacts.fields.length - 1} onClick={() => contacts.move(i, i + 1)}>
                      ↓
                    </ActionIcon>
                    <ActionIcon variant="subtle" color="red" aria-label={`Remove contact ${i + 1}`} onClick={() => contacts.remove(i)}>
                      ✕
                    </ActionIcon>
                  </Stack>
                </Group>
              </Card>
            ))}
            <Button variant="default" w="fit-content" onClick={() => contacts.append({ name: '', relationship: '', phone: '' })}>
              + Add another contact
            </Button>
          </Stack>
        )}

        {step === 4 && (
          <Card withBorder>
            <Title order={2} size="h4" mb="sm">
              Check before admitting
            </Title>
            <Table>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Th>Child</Table.Th>
                  <Table.Td>
                    {[v.firstName, v.middleNames, v.lastName].filter(Boolean).join(' ')} · born {formatDate(v.dateOfBirth)} · {v.gender}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Class</Table.Th>
                  <Table.Td>
                    {className} from {formatDate(v.admissionDate)}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Parents</Table.Th>
                  <Table.Td>
                    {v.guardians.map((g, i) => (
                      <div key={i}>
                        {g.mode === 'existing' ? g.existingLabel : `${g.firstName} ${g.lastName}`} ({g.relationship}){g.isPrimary ? ' · main contact' : ''}
                        {g.isFeePayer ? ' · pays fees' : ''}
                      </div>
                    ))}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Medical alert</Table.Th>
                  <Table.Td>{v.medical.alertSummary || 'None'}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Emergency contacts</Table.Th>
                  <Table.Td>
                    {v.contacts.map((c, i) => (
                      <div key={i}>
                        {i + 1}. {c.name} ({c.relationship}) {c.phone}
                      </div>
                    ))}
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
            {admit.error && !(admit.error instanceof ApiError && admit.error.code === 'STUDENT_POSSIBLE_DUPLICATE') && <ProblemAlert error={admit.error} />}
          </Card>
        )}

        <Group justify="space-between" mt="lg">
          <Button variant="default" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
            Back
          </Button>
          {step < 4 ? (
            <Button onClick={() => void next()}>Next</Button>
          ) : (
            <Button onClick={() => admit.mutate(undefined)} loading={admit.isPending && !duplicates}>
              Admit student
            </Button>
          )}
        </Group>
      </form>
      <DuplicateDialog opened={duplicates !== null} candidates={duplicates ?? []} onCancel={() => setDuplicates(null)} onConfirm={(reason) => admit.mutate(reason)} saving={admit.isPending} />
    </>
  );
}

function toRequest(v: FormValues, overrideReason?: string): AdmitStudentRequest {
  const blank = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  const medicalEntries = Object.entries(v.medical).filter(([, x]) => blank(x));
  return {
    firstName: v.firstName,
    middleNames: blank(v.middleNames),
    lastName: v.lastName,
    preferredName: blank(v.preferredName),
    dateOfBirth: v.dateOfBirth,
    gender: v.gender,
    nationality: 'Ghanaian',
    admissionDate: v.admissionDate,
    classId: v.classId,
    homeAddress: blank(v.homeAddress),
    previousSchool: blank(v.previousSchool),
    birthCertNo: blank(v.birthCertNo),
    religion: blank(v.religion),
    guardians: v.guardians.map((g) => ({
      guardianId: g.mode === 'existing' ? g.guardianId : undefined,
      newGuardian:
        g.mode === 'new'
          ? {
              title: blank(g.title),
              firstName: g.firstName!,
              lastName: g.lastName!,
              phonePrimary: normaliseGhanaPhone(g.phonePrimary ?? '') ?? g.phonePrimary!,
              email: blank(g.email),
              occupation: blank(g.occupation),
              ghanaCardNumber: blank(g.ghanaCardNumber),
            }
          : undefined,
      relationship: g.relationship,
      isPrimary: g.isPrimary,
      isFeePayer: g.isFeePayer,
      canPickUp: g.canPickUp,
    })),
    medical: medicalEntries.length ? (Object.fromEntries(medicalEntries.map(([k, x]) => [k, k === 'clinicPhone' ? (normaliseGhanaPhone(x!) ?? x) : x!.trim()])) as AdmitStudentRequest['medical']) : undefined,
    emergencyContacts: v.contacts.map((c, i) => ({ priority: i + 1, guardianId: c.guardianId, name: c.name, relationship: c.relationship, phone: normaliseGhanaPhone(c.phone) ?? c.phone })),
    ...(overrideReason ? { confirmNotDuplicate: true, duplicateOverrideReason: overrideReason } : {}),
  };
}

export { classOptions };
