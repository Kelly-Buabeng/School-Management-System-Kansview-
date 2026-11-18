import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_SERVICE, STUDENT_LOOKUP } from '../../src/common/contracts';
import { MessageDispatcher } from '../../src/modules/notifications/message-dispatcher';
import type { AuthUser } from '../../src/security';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createFTestApp, type FTestApp } from './app';
import { Seed } from './seed';

const CLASS_A = '0190a1b2-0000-7000-8000-00000000c1a5';
const NIGHT = new Date('2026-11-17T21:30:00Z');
const DAY = new Date('2026-11-18T10:00:00Z');

describe('messages endpoints', () => {
  let db: TestDatabase;
  let t: FTestApp;
  let seed: Seed;
  const classMembers: string[] = [];
  const owed = new Map<string, number>();
  let admin: AuthUser;
  let head: AuthUser;
  let registrar: AuthUser;
  let registrar2: AuthUser;
  let bursar: AuthUser;
  let teacher: AuthUser;
  let s1: string;
  let s3: string;
  let g1: string;
  let keyN = 0;
  const http = () => request(t.app.getHttpServer());
  const key = () => `f-test-idempotency-${Date.now()}-${++keyN}`;
  const as = (u: AuthUser) => { t.currentUser.value = u; };
  const send = (body: object, k: string | null = key()) => {
    const r = http().post('/api/v1/messages');
    if (k) r.set('Idempotency-Key', k);
    return r.send(body);
  };
  const jobCount = (messageId: string) => seed.q<{ n: string }>(
    `SELECT count(*) AS n FROM pgboss.job j JOIN message_recipients r ON r.id::text = j.data->>'recipientId' WHERE r.message_id = $1`, [messageId]).then((r) => Number(r[0]!.n));
  const setThreshold = (n: number) => seed.q(`UPDATE settings SET value = $1::jsonb WHERE key = 'messaging.bulk_approval_threshold'`, [String(n)]);
  const classAnnouncement = { kind: 'announcement', channel: 'sms', audience: { type: 'class', ids: [CLASS_A] }, variables: { message: 'PTA meeting on Friday at 3pm.' } };

  beforeAll(async () => {
    db = await createTestDatabase('f_msgs');
    t = await createFTestApp(db.url, [
      { token: STUDENT_LOOKUP, value: {
        getBillingInfo: async () => null,
        smsRecipients: async () => [],
        listActiveStudentIds: async (scope: { classIds?: string[]; school?: boolean }) => (scope.school || scope.classIds?.includes(CLASS_A) ? [...classMembers] : []),
      } },
      { token: LEDGER_SERVICE, value: {
        balance: async () => { throw new Error('not used'); },
        termCollectionSummary: async () => { throw new Error('not used'); },
        outstandingByStudent: async (ids: string[]) => new Map(ids.map((id) => [id, owed.get(id) ?? 0])),
      } },
    ]);
    seed = await Seed.connect(db.url);
    admin = await seed.user(['ADMIN']);
    head = await seed.user(['HEADTEACHER']);
    registrar = await seed.user(['REGISTRAR']);
    registrar2 = await seed.user(['REGISTRAR']);
    bursar = await seed.user(['BURSAR']);
    teacher = await seed.user(['TEACHER']);

    s1 = await seed.student('Ama', 'Mensah');
    const s2 = await seed.student('Yaw', 'Boateng');
    s3 = await seed.student('Akosua', 'Darko');
    classMembers.push(s1, s2, s3);
    g1 = await seed.guardian('+233200000201', 'Kwame', 'Mensah');
    const g2 = await seed.guardian('+233200000202', 'Kofi', 'Boateng');
    const g3 = await seed.guardian('+233200000203', 'Abena', 'Darko');
    await seed.link(s1, g1);
    await seed.link(s2, g2);
    await seed.link(s3, g3, { receivesSms: false });
    owed.set(s1, 45000);
    owed.set(s3, 1000);
  });
  beforeEach(async () => {
    t.app.get(MessageDispatcher).now = () => DAY;
    await setThreshold(50);
  });
  afterAll(async () => {
    await seed?.end();
    await t?.app.close();
    await db?.drop();
  });

  // ------------------------------------------------------------ templates
  describe('templates', () => {
    it('lists seeded templates with allowed placeholders', async () => {
      as(bursar);
      const r = await http().get('/api/v1/message-templates').expect(200);
      const fee = r.body.data.find((x: { code: string }) => x.code === 'fee_reminder');
      expect(fee.allowedPlaceholders).toContain('balance');
      expect(fee.placeholders).toContain('guardianName');
    });

    it('validates placeholders on create and update (TEMPLATE_PLACEHOLDER_INVALID)', async () => {
      as(admin);
      const bad = await http().post('/api/v1/message-templates').send({ code: 'fee_reminder', channel: 'whatsapp', name: 'WA', body: 'Dear {{guardianName}}, your PIN is {{password}}' }).expect(422);
      expect(bad.body.code).toBe('TEMPLATE_PLACEHOLDER_INVALID');
      const html = await http().post('/api/v1/message-templates').send({ code: 'announcement', channel: 'whatsapp', name: 'WA', body: '<b>{{message}}</b>' }).expect(422);
      expect(html.body.code).toBe('TEMPLATE_PLACEHOLDER_INVALID');
      const ok = await http().post('/api/v1/message-templates').send({ code: 'announcement', channel: 'whatsapp', name: 'WhatsApp announcement', body: '{{schoolName}}: {{message}}' }).expect(201);
      await http().post('/api/v1/message-templates').send({ code: 'announcement', channel: 'whatsapp', name: 'Again', body: '{{message}}' }).expect(409);
      await http().post('/api/v1/message-templates').send({ code: 'announcement', name: 'x', body: 'y', admin: true }).expect(400); // strict body
      await http().patch(`/api/v1/message-templates/${ok.body.id}`).set('If-Match', '99').send({ name: 'Renamed' }).expect(412);
      const upd = await http().patch(`/api/v1/message-templates/${ok.body.id}`).set('If-Match', String(ok.body.version)).send({ name: 'Renamed' }).expect(200);
      expect(upd.body.name).toBe('Renamed');
      expect((await http().patch(`/api/v1/message-templates/${ok.body.id}`).send({ body: 'Hi {{balance}}' }).expect(422)).body.code).toBe('TEMPLATE_PLACEHOLDER_INVALID');
      await http().patch('/api/v1/message-templates/0190a1b2-0000-7000-8000-000000000000').send({ name: 'x' }).expect(404);
    });

    it('denies template changes to non-admin roles', async () => {
      as(bursar);
      await http().post('/api/v1/message-templates').send({ code: 'announcement', name: 'x', body: '{{message}}' }).expect(403);
      as(teacher);
      await http().get('/api/v1/message-templates').expect(403);
    });
  });

  // ------------------------------------------------------------ preview / send
  it('preview shows recipients, opt-outs, masked samples, segments and cost', async () => {
    as(registrar);
    const r = await http().post('/api/v1/messages/preview').send(classAnnouncement).expect(200);
    expect(r.body).toMatchObject({ recipientCount: 2, optedOutCount: 1, encoding: 'GSM-7', segmentsPerMessage: 1, totalSegments: 2, estimatedCostPesewas: 6, needsApproval: false });
    expect(r.body.samples[0].to).toMatch(/^\+233\*{5}\d{4}$/);
    expect(r.body.samples[0].body).toContain('PTA meeting on Friday');
  });

  it('requires an Idempotency-Key and replays the same response for the same key', async () => {
    as(registrar);
    await send(classAnnouncement, null).expect(400);
    const k = key();
    const a = await send(classAnnouncement, k).expect(202);
    const b = await send(classAnnouncement, k).expect(202);
    expect(b.body.id).toBe(a.body.id);
    expect(a.body).toMatchObject({ status: 'queued', recipientCount: 3, queued: 2, skippedOptOut: 1 });
    expect(await jobCount(a.body.id)).toBe(2);
  });

  it('bulk above the threshold waits for approval unless the sender can approve', async () => {
    await setThreshold(1);
    as(registrar);
    const r = await send(classAnnouncement).expect(202);
    expect(r.body).toMatchObject({ status: 'pending_approval', needsApproval: true, queued: 0 });
    expect(r.body.notice.code).toBe('MESSAGE_NEEDS_APPROVAL');
    expect(await jobCount(r.body.id)).toBe(0);

    await http().post(`/api/v1/messages/${r.body.id}/approve`).expect(403); // registrar cannot approve
    as(head);
    await http().post(`/api/v1/messages/${r.body.id}/approve`).expect(403); // no messages:bulk_approve
    as(admin);
    const ap = await http().post(`/api/v1/messages/${r.body.id}/approve`).expect(200);
    expect(ap.body).toMatchObject({ status: 'queued', queued: 2 });
    expect(await jobCount(r.body.id)).toBe(2);
    await http().post(`/api/v1/messages/${r.body.id}/approve`).expect(409);

    const direct = await send(classAnnouncement).expect(202); // admin has messages:bulk_approve
    expect(direct.body.status).toBe('queued');
  });

  it('emergency needs messages:emergency, skips approval and quiet hours, and reaches opted-out guardians', async () => {
    await setThreshold(1);
    t.app.get(MessageDispatcher).now = () => NIGHT;
    const emergency = { kind: 'emergency', audience: { type: 'school' }, variables: { message: 'School closing at noon due to flooding.' } };
    as(registrar);
    await send(emergency).expect(403);
    as(head);
    const r = await send(emergency).expect(202);
    expect(r.body).toMatchObject({ status: 'queued', needsApproval: false, queued: 3, skippedOptOut: 0 });
    const jobs = await seed.q<{ start_after: Date }>(`SELECT j.start_after FROM pgboss.job j JOIN message_recipients r ON r.id::text = j.data->>'recipientId' WHERE r.message_id = $1`, [r.body.id]);
    for (const j of jobs) expect(new Date(j.start_after).getTime()).toBeLessThan(new Date('2026-11-18T07:00:00Z').getTime());

    const normal = await send(classAnnouncement).expect(202); // head: over threshold → approval; at night
    expect(normal.body.status).toBe('pending_approval');
  });

  it('non-emergency sends at night are delayed to 07:00', async () => {
    t.app.get(MessageDispatcher).now = () => NIGHT;
    as(registrar);
    const r = await send({ ...classAnnouncement, audience: { type: 'students', ids: [s1] } }).expect(202);
    const [j] = await seed.q<{ start_after: Date }>(`SELECT j.start_after FROM pgboss.job j JOIN message_recipients r ON r.id::text = j.data->>'recipientId' WHERE r.message_id = $1`, [r.body.id]);
    expect(new Date(j!.start_after).toISOString()).toBe('2026-11-18T07:00:00.000Z');
  });

  it('bursar: fee reminders to defaulters only, with balances in the text', async () => {
    as(bursar);
    await send(classAnnouncement).expect(403);
    const r = await send({ kind: 'fee_reminder', audience: { type: 'defaulters' }, variables: { termName: 'Term 1', dueDate: '30 Nov 2026' } }).expect(202);
    expect(r.body).toMatchObject({ recipientCount: 2, queued: 1, skippedOptOut: 1 });
    const rs = await seed.q<{ body: string; student_id: string }>('SELECT body, student_id FROM message_recipients WHERE message_id = $1', [r.body.id]);
    const ama = rs.find((x) => x.student_id === s1)!;
    expect(ama.body).toContain('Dear Kwame Mensah, Ama Mensah');
    expect(ama.body).toContain('GHS 450.00');
    expect(ama.body).toContain('30 Nov 2026');
  });

  it('rejects bad custom bodies and variables', async () => {
    as(registrar);
    const a = await send({ kind: 'announcement', body: 'Hi {{guardianName}}, owes {{balance}} {{secret}}', audience: { type: 'students', ids: [s1] } }).expect(422);
    expect(a.body.code).toBe('TEMPLATE_PLACEHOLDER_INVALID');
    const b = await send({ kind: 'announcement', audience: { type: 'students', ids: [s1] }, variables: { guardianName: 'Spoofed' } }).expect(422);
    expect(b.body.code).toBe('TEMPLATE_PLACEHOLDER_INVALID');
    await send({ kind: 'announcement', audience: { type: 'class' } }).expect(400);
    await send({ kind: 'announcement', audience: { type: 'students', ids: ['0190a1b2-0000-7000-8000-000000000999'] } }).expect(404);
    await send({ kind: 'announcement', channel: 'whatsapp', audience: { type: 'students', ids: [s1] } }).expect(422);
    await send({ kind: 'announcement', audience: { type: 'students', ids: [s1] }, priority: 'high' }).expect(400);
  });

  it('teacher has no access to messages', async () => {
    as(teacher);
    await http().get('/api/v1/messages').expect(403);
    await send(classAnnouncement).expect(403);
    await http().post('/api/v1/messages/preview').send(classAnnouncement).expect(403);
  });

  // ------------------------------------------------------------ read / delivery log / retry
  it('registrars see their own sends only; others get 404 (IDOR); headteacher sees all', async () => {
    as(registrar);
    const mine = await send({ ...classAnnouncement, audience: { type: 'students', ids: [s1, s3] } }).expect(202);
    const list = await http().get('/api/v1/messages').expect(200);
    expect(list.body.data.every((m: { requestedBy: string }) => m.requestedBy === registrar.id)).toBe(true);
    const one = await http().get(`/api/v1/messages/${mine.body.id}`).expect(200);
    expect(one.body.delivery).toMatchObject({ queued: 1, skipped_opt_out: 1 });

    const log = await http().get(`/api/v1/messages/${mine.body.id}/recipients`).expect(200);
    expect(log.body.total).toBe(2);
    expect(log.body.data[0].phone).toMatch(/\*{5}/);

    as(registrar2);
    await http().get(`/api/v1/messages/${mine.body.id}`).expect(404);
    await http().get(`/api/v1/messages/${mine.body.id}/recipients`).expect(404);
    await http().post(`/api/v1/messages/${mine.body.id}/retry-failed`).expect(404);
    as(head);
    await http().get(`/api/v1/messages/${mine.body.id}`).expect(200);
    await http().get('/api/v1/messages/not-a-uuid').expect(404);
  });

  it('retry-failed re-queues failed recipients', async () => {
    as(registrar);
    const m = await send({ ...classAnnouncement, audience: { type: 'students', ids: [s1] } }).expect(202);
    await seed.q(`UPDATE message_recipients SET status = 'failed', last_error = 'x' WHERE message_id = $1`, [m.body.id]);
    const before = await jobCount(m.body.id);
    const r = await http().post(`/api/v1/messages/${m.body.id}/retry-failed`).expect(202);
    expect(r.body.retried).toBe(1);
    expect(await jobCount(m.body.id)).toBe(before + 1);
    const [row] = await seed.q<{ status: string }>('SELECT status FROM message_recipients WHERE message_id = $1', [m.body.id]);
    expect(row!.status).toBe('queued');
    expect((await http().get(`/api/v1/messages/${m.body.id}`).expect(200)).body.status).toBe('sending');
  });

  it('guardian audience sends one SMS per guardian', async () => {
    as(registrar);
    const r = await send({ kind: 'announcement', audience: { type: 'guardians', ids: [g1] }, variables: { message: 'Hello' } }).expect(202);
    expect(r.body).toMatchObject({ recipientCount: 1, queued: 1 });
  });
});
