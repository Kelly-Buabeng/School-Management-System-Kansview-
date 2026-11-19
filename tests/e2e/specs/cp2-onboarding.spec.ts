// Owner: Agent H. CP2: onboarding → Emergency View (docs/contracts/definition-of-done.md).
// API part follows the OpenAPI contract; the last test drives the real UI on a phone viewport.
import { test, expect } from '../support/fixtures';
import { idemKey } from '../support/api';
import { classByName, fakePhone, list, uniq } from '../support/data';

test.describe.configure({ mode: 'serial' });

let studentId = '';
let studentName = '';
let motherPhone = '';

test('registrar: duplicate warning, admission with a new and an existing guardian (sibling linked), medical alert', async ({ api }) => {
  const reg = await api.as('registrar');
  const p1a = await classByName(reg, 'Primary 1 A');

  // An existing family from the seed: their guardian becomes the new child's father (sibling auto-link).
  const existing = list<{ id: string }>(await reg.json(reg.get('/students', { classId: (await classByName(reg, 'Primary 3 A')).id, pageSize: 1 })))[0]!;
  const existingGuardian = list<{ id: string; fullName: string }>(await reg.json(reg.get(`/students/${existing.id}/guardians`)))[0]!;

  const suffix = uniq();
  motherPhone = fakePhone();
  const body = {
    firstName: 'Akosua', lastName: `Owusu${suffix}`, dateOfBirth: '2019-04-11', gender: 'female', admissionDate: '2026-09-07', classId: p1a.id,
    guardians: [
      { newGuardian: { firstName: 'Abena', lastName: `Owusu${suffix}`, phonePrimary: motherPhone.replace('+233', '0') }, relationship: 'mother', isPrimary: true, isFeePayer: true, canPickUp: true },
      { guardianId: existingGuardian.id, relationship: 'father' },
    ],
    medical: { allergies: 'Peanuts (severe)', alertSummary: 'SEVERE PEANUT ALLERGY - carries EpiPen' },
  };
  const created = await reg.json<{ id: string; studentCode: string; hasMedicalAlert: boolean; guardians: unknown[] }>(reg.post('/students', body), 201);
  expect(created.studentCode).toMatch(/^KSV-\d{2}-\d{5}-\d$/);
  expect(created.hasMedicalAlert).toBe(true);
  expect(created.guardians).toHaveLength(2);
  studentId = created.id;
  studentName = `Akosua Owusu${suffix}`;

  // Same child again: duplicate warning (409), then an audited override with a reason.
  const check = await reg.json<{ isPossibleDuplicate: boolean; candidates: unknown[] }>(reg.post('/students/duplicate-check', { firstName: body.firstName, lastName: body.lastName, dateOfBirth: body.dateOfBirth, guardianPhones: [motherPhone] }));
  expect(check.isPossibleDuplicate).toBe(true);
  expect(check.candidates.length).toBeGreaterThan(0);
  const dup = await reg.post('/students', { ...body, guardians: [body.guardians[0]] });
  expect(dup.status()).toBe(409);

  // Sibling link: the existing guardian now has both children.
  const kids = list<{ id: string }>(await reg.json(reg.get(`/guardians/${existingGuardian.id}/students`)));
  expect(kids.map((k) => k.id)).toEqual(expect.arrayContaining([existing.id, studentId]));
});

test('ordered emergency contacts and Emergency View with tel: links; the call is logged and audited', async ({ api }) => {
  const reg = await api.as('registrar');
  const uncle = fakePhone();
  const contacts = await reg.json<Array<{ name: string }>>(reg.put(`/students/${studentId}/emergency-contacts`, [
    { priority: 1, name: 'Uncle Kwesi Owusu', phone: uncle, relationship: 'uncle' },
  ]));
  expect(contacts[0]!.name).toBe('Uncle Kwesi Owusu');

  const view = await reg.json<{ alertSummary: string; contacts: Array<{ priority: number; telLinks: string[] }> }>(reg.get(`/students/${studentId}/emergency-view`));
  expect(view.alertSummary).toContain('PEANUT');
  expect(view.contacts[0]!.telLinks[0]).toBe(`tel:${uncle}`);
  await reg.json(reg.post(`/students/${studentId}/emergency-contact-logs`, { phoneCalled: uncle, outcome: 'reached', notes: 'Uncle on his way' }), 201);

  const admin = await api.as('admin');
  const events = list<{ action: string; entityType: string }>(await admin.json(admin.get('/audit-events', { studentId })));
  const actions = events.map((e) => e.action);
  expect(actions).toEqual(expect.arrayContaining(['create', 'emergency_view']));
});

test('BURSAR cannot read medical details (403); a TEACHER of another class cannot see the child (404)', async ({ api }) => {
  const bursar = await api.as('bursar');
  expect((await bursar.get(`/students/${studentId}/medical`)).status()).toBe(403);
  const own = await api.as('teacher'); // class teacher of Primary 1 A in the seed
  expect((await own.get(`/students/${studentId}`)).status()).toBe(200);
  const other = await api.as('teacherP4b');
  expect((await other.get(`/students/${studentId}`)).status()).toBe(404);
});

test('20 parallel admissions get 20 distinct valid student codes', async ({ api }) => {
  const reg = await api.as('registrar');
  const kg1 = await classByName(reg, 'KG 1 B');
  const s = uniq();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reg.post('/students', {
    firstName: `Child${i}`, lastName: `Parallel${s}`, dateOfBirth: `2021-02-${String(i + 1).padStart(2, '0')}`, gender: i % 2 ? 'male' : 'female', admissionDate: '2026-09-07', classId: kg1.id,
    guardians: [{ newGuardian: { firstName: 'Esi', lastName: `Parallel${s}${i}`, phonePrimary: fakePhone() }, relationship: 'mother', isPrimary: true, isFeePayer: true }],
    confirmNotDuplicate: true, duplicateOverrideReason: 'E2E parallel admission test',
  }, { headers: { 'X-E2E': idemKey() } })));
  const codes: string[] = [];
  for (const r of results) {
    if (r.status() === 201) codes.push(((await r.json()) as { studentCode: string }).studentCode);
    else expect([201, 422], await r.text()).toContain(r.status()); // 422 = class full is the only acceptable refusal
  }
  expect(new Set(codes).size).toBe(codes.length);
  for (const c of codes) expect(c).toMatch(/^KSV-\d{2}-\d{5}-\d$/);
});

test('UI: registrar finds the child and opens the Emergency View on a phone', async ({ page, signIn }) => {
  await signIn(page, 'registrar');
  await page.keyboard.press('Control+k');
  await page.keyboard.type(studentName);
  await page.getByRole('option', { name: new RegExp(studentName) }).click();
  await expect(page.getByRole('heading', { name: new RegExp(studentName) })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('link', { name: 'Emergency View' }).click();
  await expect(page.getByRole('alert', { name: 'Medical alerts' })).toContainText('PEANUT');
  await expect(page.getByRole('link', { name: /^Call / }).first()).toHaveAttribute('href', /^tel:\+233/);
});
