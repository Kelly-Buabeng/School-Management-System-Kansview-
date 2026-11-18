import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_SERVICE, type NotificationService } from '../../src/common/contracts';
import { DeliveryProcessor } from '../../src/modules/notifications/delivery.processor';
import { MessageDispatcher } from '../../src/modules/notifications/message-dispatcher';
import { NotificationsWorker } from '../../src/modules/notifications/notifications.worker';
import { MESSAGE_PROVIDER } from '../../src/modules/notifications/providers/message-provider';
import type { MockProvider } from '../../src/modules/notifications/providers/mock.provider';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createFTestApp, type FTestApp } from './app';
import { Seed } from './seed';

const DAYTIME = new Date('2026-11-18T10:00:00Z');
const NIGHT = new Date('2026-11-17T21:30:00Z');

function useClock(t: FTestApp, at: Date): void {
  t.app.get(DeliveryProcessor).now = () => at;
  t.app.get(MessageDispatcher).now = () => at;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`condition not met in ${timeoutMs} ms: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('NotificationService queue and delivery', () => {
  let db: TestDatabase;
  let t: FTestApp;
  let seed: Seed;
  let notify: NotificationService;
  let processor: DeliveryProcessor;
  let provider: MockProvider;
  let studentId: string;
  let guardianId: string;
  let optedOutGuardianId: string;
  const PHONE = '+233200000101';
  const OPTED_OUT_PHONE = '+233200000102';

  const recipients = (messageId: string) =>
    seed.q<{ id: string; status: string; phone: string; body: string; cost_units: number | null; provider_message_id: string | null }>(
      'SELECT * FROM message_recipients WHERE message_id = $1 ORDER BY phone', [messageId]);
  const attempts = (recipientId: string) =>
    seed.q<{ attempt_no: number; error: string | null; provider: string }>('SELECT * FROM delivery_attempts WHERE recipient_id = $1 ORDER BY attempt_no', [recipientId]);
  const jobs = (recipientId: string) =>
    seed.q<{ state: string; start_after: Date; retry_limit: number; retry_backoff: boolean; retry_delay: number }>(
      `SELECT state, start_after, retry_limit, retry_backoff, retry_delay FROM pgboss.job WHERE name = 'sms-send' AND data->>'recipientId' = $1 ORDER BY created_on`, [recipientId]);

  beforeAll(async () => {
    db = await createTestDatabase('f_queue');
    t = await createFTestApp(db.url);
    seed = await Seed.connect(db.url);
    notify = t.app.get(NOTIFICATION_SERVICE);
    processor = t.app.get(DeliveryProcessor);
    provider = t.app.get(MESSAGE_PROVIDER);
    studentId = await seed.student('Ama', 'Mensah');
    guardianId = await seed.guardian(PHONE, 'Kwame', 'Mensah');
    optedOutGuardianId = await seed.guardian(OPTED_OUT_PHONE, 'Esi', 'Mensah');
    await seed.link(studentId, guardianId, { primary: true });
    await seed.link(studentId, optedOutGuardianId, { primary: false, receivesSms: false });
  });
  beforeEach(() => {
    provider.reset();
    useClock(t, DAYTIME);
  });
  afterAll(async () => {
    await seed?.end();
    await t?.app.close();
    await db?.drop();
  });

  it('enqueue writes the message, renders the template and queues a retrying job', async () => {
    const { messageId } = await notify.enqueue('absence_alert', [{ guardianId, studentId, phone: PHONE }], { guardianName: 'Kwame Mensah', studentName: 'Ama Mensah', date: '18 Nov 2026' });
    const [msg] = await seed.q<{ status: string; kind: string; recipient_count: number }>('SELECT * FROM messages WHERE id = $1', [messageId]);
    expect(msg).toMatchObject({ status: 'queued', kind: 'absence_alert', recipient_count: 1 });
    const [r] = await recipients(messageId);
    expect(r!.status).toBe('queued');
    expect(r!.body).toContain('Dear Kwame Mensah, Ama Mensah was marked absent from school today, 18 Nov 2026.');
    expect(r!.body).toContain('Kansview'); // schoolName from school_profile
    const [job] = await jobs(r!.id);
    expect(job).toMatchObject({ state: 'created', retry_limit: 4, retry_backoff: true, retry_delay: 30 });
    expect(provider.deliveryLog).toHaveLength(0); // never sends synchronously
  });

  it('dedupeKey prevents duplicates', async () => {
    const a = await notify.enqueue('absence_alert', [{ guardianId, studentId, phone: PHONE }], { date: 'x' }, { dedupeKey: `absence:${studentId}:2026-11-18` });
    const b = await notify.enqueue('absence_alert', [{ guardianId, studentId, phone: PHONE }], { date: 'x' }, { dedupeKey: `absence:${studentId}:2026-11-18` });
    expect(b.messageId).toBe(a.messageId);
    const rows = await seed.q('SELECT id FROM messages WHERE dedupe_key = $1', [`absence:${studentId}:2026-11-18`]);
    expect(rows).toHaveLength(1);
    expect(await recipients(a.messageId)).toHaveLength(1);
  });

  it('skips guardians who opted out of SMS (no job queued), except for emergencies', async () => {
    const { messageId } = await notify.enqueue('announcement', [
      { guardianId, studentId, phone: PHONE }, { guardianId: optedOutGuardianId, studentId, phone: OPTED_OUT_PHONE },
    ], { message: 'PTA meeting on Friday' });
    const rs = await recipients(messageId);
    expect(rs.map((r) => r.status)).toEqual(['queued', 'skipped_opt_out']);
    expect(await jobs(rs[1]!.id)).toHaveLength(0);
    const em = await notify.enqueue('emergency', [{ guardianId: optedOutGuardianId, studentId, phone: OPTED_OUT_PHONE }], { message: 'Flooding, pick up children now.' });
    expect((await recipients(em.messageId))[0]!.status).toBe('queued');
  });

  it('sends successfully and records the attempt, cost and provider id', async () => {
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Hello' });
    const [r] = await recipients(messageId);
    expect(await processor.process(r!.id, 1)).toBe('sent');
    const [after] = await recipients(messageId);
    expect(after).toMatchObject({ status: 'sent', cost_units: 1 });
    expect(after!.provider_message_id).toMatch(/^mock-/);
    expect(await attempts(r!.id)).toEqual([expect.objectContaining({ attempt_no: 1, error: null, provider: 'mock' })]);
    expect((await seed.q<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId]))[0]!.status).toBe('done');
    expect(await processor.process(r!.id, 1)).toBe('skipped'); // a duplicate job never double-sends
    expect(provider.deliveryLog).toHaveLength(1);
  });

  it('retries temporary failures and records every attempt', async () => {
    provider.failNext(PHONE, 2);
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Retry me' });
    const [r] = await recipients(messageId);
    expect(await processor.process(r!.id, 1)).toBe('retry');
    expect((await seed.q<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId]))[0]!.status).toBe('sending');
    expect(await processor.process(r!.id, 2)).toBe('retry');
    expect(await processor.process(r!.id, 3)).toBe('sent');
    const a = await attempts(r!.id);
    expect(a.map((x) => x.attempt_no)).toEqual([1, 2, 3]);
    expect(a[0]!.error).toContain('temporarily');
  });

  it('gives up after 5 attempts and marks the message partially failed', async () => {
    provider.failNext(PHONE, 10);
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Never arrives' });
    const [r] = await recipients(messageId);
    for (let i = 1; i <= 4; i++) expect(await processor.process(r!.id, i)).toBe('retry');
    expect(await processor.process(r!.id, 5)).toBe('failed');
    expect((await recipients(messageId))[0]!.status).toBe('failed');
    expect(await attempts(r!.id)).toHaveLength(5);
    expect((await seed.q<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId]))[0]!.status).toBe('partially_failed');
  });

  it('fails immediately for permanent errors (invalid number)', async () => {
    provider.permanentFailureNumbers.add(PHONE);
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Bad number' });
    const [r] = await recipients(messageId);
    expect(await processor.process(r!.id, 1)).toBe('failed');
    expect(await attempts(r!.id)).toHaveLength(1);
  });

  it('delays non-emergency messages queued in quiet hours to 07:00 Accra', async () => {
    useClock(t, NIGHT);
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Night' });
    const [r] = await recipients(messageId);
    const [job] = await jobs(r!.id);
    expect(new Date(job!.start_after).toISOString()).toBe('2026-11-18T07:00:00.000Z');
    // A job that runs during quiet hours is deferred to a new 07:00 job, not sent.
    expect(await processor.process(r!.id, 1)).toBe('deferred');
    expect(provider.deliveryLog).toHaveLength(0);
    const js = await jobs(r!.id);
    expect(js).toHaveLength(2);
    expect(new Date(js[1]!.start_after).toISOString()).toBe('2026-11-18T07:00:00.000Z');
  });

  it('never delays emergencies for quiet hours', async () => {
    useClock(t, NIGHT);
    const { messageId } = await notify.enqueue('emergency', [{ guardianId, studentId, phone: PHONE }], { message: 'Close early' });
    const [r] = await recipients(messageId);
    const [job] = await jobs(r!.id);
    expect(new Date(job!.start_after).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await processor.process(r!.id, 1)).toBe('sent');
  });

  it('rejects numbers not in E.164 format', async () => {
    await expect(notify.enqueue('announcement', [{ phone: '0240000000' }], { message: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  it('queue survives a restart: a job enqueued by one process is delivered after a new worker starts', async () => {
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Survives restart' });
    await t.app.close(); // API process goes away with the job still queued in PostgreSQL

    // The fake daytime clock put start_after in the future; make the job due now.
    await seed.q(`UPDATE pgboss.job SET start_after = now() WHERE name = 'sms-send' AND state = 'created'`);
    t = await createFTestApp(db.url);
    useClock(t, DAYTIME);
    provider = t.app.get(MESSAGE_PROVIDER);
    notify = t.app.get(NOTIFICATION_SERVICE);
    processor = t.app.get(DeliveryProcessor);
    await t.app.get(NotificationsWorker).start({ pollingIntervalSeconds: 0.5 });
    const [r] = await waitFor(() => recipients(messageId), (rs) => rs[0]?.status === 'sent');
    expect(r!.status).toBe('sent');
    expect(provider.deliveryLog.map((l) => l.body)).toContainEqual(expect.stringContaining('Survives restart'));
    await waitFor(() => jobs(r!.id), (js) => js.every((j) => j.state === 'completed'));
  });

  it('the worker retries via pg-boss after a temporary failure', async () => {
    provider.failNext(PHONE, 1);
    // Short retry delay for the test: update the queued job directly.
    const { messageId } = await notify.enqueue('announcement', [{ guardianId, studentId, phone: PHONE }], { message: 'Worker retry' });
    const [r] = await recipients(messageId);
    await seed.q(`UPDATE pgboss.job SET retry_delay = 0, retry_backoff = false, start_after = now() WHERE data->>'recipientId' = $1`, [r!.id]);
    await waitFor(() => recipients(messageId), (rs) => rs[0]?.status === 'sent');
    expect((await attempts(r!.id)).map((a) => a.attempt_no)).toEqual([1, 2]);
  });
});
