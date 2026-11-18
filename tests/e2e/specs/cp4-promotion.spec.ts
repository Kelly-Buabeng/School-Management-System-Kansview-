// Owner: Agent H. CP4: year-end promotion with exceptions, arrears block + override, commit, and exact undo.
import { createHash } from 'node:crypto';
import { test, expect } from '../support/fixtures';
import { idemKey, type ApiSession } from '../support/api';
import { classByName, classes, list, type YearRow } from '../support/data';

test.describe.configure({ mode: 'serial' });

interface Item { id: string; studentId: string; action: string; targetClassId: string | null; arrearsFlag: boolean; blocked: boolean }
interface Run { id: string; status: string; items: Item[]; undoDeadline?: string }

async function nextYear(admin: ApiSession): Promise<YearRow> {
  const years = list<YearRow>(await admin.json(admin.get('/academic-years')));
  const found = years.find((y) => y.name === '2027/2028');
  if (found) return found;
  return admin.json<YearRow>(admin.post('/academic-years', {
    name: '2027/2028', startDate: '2027-09-06', endDate: '2028-07-28',
    terms: [
      { number: 1, startDate: '2027-09-06', endDate: '2027-12-17' },
      { number: 2, startDate: '2028-01-10', endDate: '2028-04-07' },
      { number: 3, startDate: '2028-04-24', endDate: '2028-07-21' },
    ],
  }), 201);
}

async function ensureClass(admin: ApiSession, yearId: string, levelId: string, stream: string): Promise<string> {
  const existing = (await classes(admin, yearId)).find((c) => c.levelId === levelId && c.stream === stream);
  if (existing) return existing.id;
  return (await admin.json<{ id: string }>(admin.post('/classes', { academicYearId: yearId, levelId, stream, capacity: 60 }), 201)).id;
}

/** Fingerprint of the enrolment history and status of the given students (order-independent). */
async function checksum(s: ApiSession, studentIds: string[]): Promise<string> {
  const parts: string[] = [];
  for (const id of [...studentIds].sort()) {
    const st = await s.json<{ status: string }>(s.get(`/students/${id}`));
    const enr = list<{ classId: string; status: string; startDate: string; endDate: string | null; rollNumber: number | null }>(await s.json(s.get(`/students/${id}/enrolments`)));
    parts.push(`${id}|${st.status}|${enr.map((e) => `${e.classId}:${e.status}:${e.startDate}:${e.endDate}:${e.rollNumber}`).join(',')}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

let run: Run;
let before = '';
let studentIds: string[] = [];

test('preview with exceptions and the arrears policy "block"', async ({ api }) => {
  const admin = await api.as('admin');
  const from = await classByName(admin, 'Primary 2 A');
  const p3 = await classByName(admin, 'Primary 3 A');
  const year = await nextYear(admin);
  await ensureClass(admin, year.id, p3.levelId, 'A');
  const repeatClass = await ensureClass(admin, year.id, from.levelId, 'A');

  const policies = await admin.get('/settings/policies');
  await admin.json(admin.patch('/settings/policies', { 'promotion.block_on_arrears': 'block' }, { 'If-Match': policies.headers()['etag'] ?? '' }));

  run = await admin.json<Run>(admin.post('/promotion-runs', { toAcademicYearId: year.id, classIds: [from.id] }), 201);
  expect(run.status).toBe('draft');
  expect(run.items.length).toBeGreaterThan(5);
  studentIds = run.items.map((i) => i.studentId);
  expect(run.items.filter((i) => i.action === 'promote').length).toBeGreaterThan(0);

  // Exceptions: one repeats, one transfers out.
  const [repeat, leave] = run.items.filter((i) => !i.arrearsFlag);
  await admin.json(admin.patch(`/promotion-runs/${run.id}/items/${repeat!.id}`, { action: 'repeat', targetClassId: repeatClass }));
  await admin.json(admin.patch(`/promotion-runs/${run.id}/items/${leave!.id}`, { action: 'transfer_out' }));
});

test('blocked students stop the commit until an override reason is given; commit keeps history', async ({ api }) => {
  const admin = await api.as('admin');
  run = await admin.json<Run>(admin.get(`/promotion-runs/${run.id}`));
  const blocked = run.items.filter((i) => i.blocked);
  if (blocked.length > 0) {
    const r = await admin.post(`/promotion-runs/${run.id}/commit`, {}, { idempotencyKey: idemKey() });
    expect(r.status()).toBe(422);
    for (const b of blocked) await admin.json(admin.patch(`/promotion-runs/${run.id}/items/${b.id}`, { overrideReason: 'Payment plan agreed with the family (e2e)' }));
  }
  before = await checksum(admin, studentIds);
  const committed = await admin.json<Run>(admin.post(`/promotion-runs/${run.id}/commit`, {}, { idempotencyKey: idemKey() }));
  expect(committed.status).toBe('committed');
  expect(committed.undoDeadline).toBeTruthy();

  const promoted = run.items.find((i) => i.action === 'promote')!;
  const hist = list<{ status: string; endDate: string | null }>(await admin.json(admin.get(`/students/${promoted.studentId}/enrolments`)));
  expect(hist.at(-2)!.status).toBe('completed');
  expect(hist.at(-1)).toMatchObject({ status: 'active', endDate: null });
  expect(await checksum(admin, studentIds)).not.toBe(before);
});

test('undo within the window restores exactly the previous state (checksum); a second undo is refused', async ({ api }) => {
  const reg = await api.as('registrar');
  expect((await reg.post(`/promotion-runs/${run.id}/undo`, { reason: 'Wrong class chosen' })).status()).toBe(403);
  const admin = await api.as('admin');
  const undone = await admin.json<Run>(admin.post(`/promotion-runs/${run.id}/undo`, { reason: 'Wrong class chosen (e2e)' }));
  expect(undone.status).toBe('undone');
  expect(await checksum(admin, studentIds)).toBe(before);
  expect((await admin.post(`/promotion-runs/${run.id}/undo`, { reason: 'again' })).status()).toBe(422);
});

test('undo after the window is refused', async () => {
  test.fixme(true, 'Needs a clock override in the running API; covered by apps/api/test/b/promotion.int-spec.ts.');
});
