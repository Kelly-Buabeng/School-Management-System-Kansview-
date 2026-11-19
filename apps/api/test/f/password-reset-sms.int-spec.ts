// CP5-06: a password reset code is sent by SMS but never stored readable (delivery log, database rows, queue job).
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_SERVICE, type NotificationService } from '../../src/common/contracts';
import { DeliveryProcessor } from '../../src/modules/notifications/delivery.processor';
import { MessageDispatcher } from '../../src/modules/notifications/message-dispatcher';
import { REDACTED_VALUE } from '../../src/modules/notifications/notification.service';
import { MESSAGE_PROVIDER } from '../../src/modules/notifications/providers/message-provider';
import type { MockProvider } from '../../src/modules/notifications/providers/mock.provider';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { fakeUser } from '../support/test-app';
import { createFTestApp, type FTestApp } from './app';
import { Seed } from './seed';

const DAYTIME = new Date('2026-11-18T10:00:00Z');
const NIGHT = new Date('2026-11-17T21:30:00Z');
const PHONE = '+233240000555';
// Same shape as the real token (32 random bytes, base64url): fake value for the test.
const CODE = 'Q2FwZUNvYXN0LUthbnN2aWV3LXJlc2V0LXRva2VuMDE';

describe('password reset SMS (CP5-06)', () => {
  let db: TestDatabase;
  let t: FTestApp;
  let seed: Seed;
  let notify: NotificationService;
  let processor: DeliveryProcessor;
  let provider: MockProvider;

  const recipient = async (messageId: string) =>
    (await seed.q<{ id: string; body: string; status: string; last_error: string | null }>('SELECT id, body, status, last_error FROM message_recipients WHERE message_id = $1', [messageId]))[0]!;
  const jobData = async (recipientId: string) =>
    (await seed.q<{ data: { recipientId: string; sealedBody?: string }; start_after: Date }>(`SELECT data, start_after FROM pgboss.job WHERE name = 'sms-send' AND data->>'recipientId' = $1 ORDER BY created_on`, [recipientId]));
  const clock = (at: Date) => {
    t.app.get(DeliveryProcessor).now = () => at;
    t.app.get(MessageDispatcher).now = () => at;
  };

  beforeAll(async () => {
    db = await createTestDatabase('f_reset');
    t = await createFTestApp(db.url);
    seed = await Seed.connect(db.url);
    notify = t.app.get(NOTIFICATION_SERVICE);
    processor = t.app.get(DeliveryProcessor);
    provider = t.app.get(MESSAGE_PROVIDER);
  });
  beforeEach(() => {
    provider.reset();
    clock(DAYTIME);
  });
  afterAll(async () => {
    await seed?.end();
    await t?.app.close();
    await db?.drop();
  });

  it('the code reaches the phone but is redacted in the stored message, the delivery log and the queue job', async () => {
    const { messageId } = await notify.enqueue('password_reset', [{ phone: PHONE }], { code: CODE, minutes: 30 }, { requestedByUserId: null });
    const [msg] = await seed.q<{ body_rendered_preview: string }>('SELECT body_rendered_preview FROM messages WHERE id = $1', [messageId]);
    const r = await recipient(messageId);
    for (const stored of [msg!.body_rendered_preview, r.body]) {
      expect(stored).not.toContain(CODE);
      expect(stored).toContain(`your password reset code is ${REDACTED_VALUE}. It expires in 30 minutes`);
    }
    const [job] = await jobData(r.id);
    expect(JSON.stringify(job!.data)).not.toContain(CODE); // encrypted in the job

    // ADMIN reading the delivery log sees the redacted text only.
    t.currentUser.value = fakeUser(['ADMIN']);
    const http = () => request(t.app.getHttpServer());
    const one = await http().get(`/api/v1/messages/${messageId}`).expect(200);
    const rec = await http().get(`/api/v1/messages/${messageId}/recipients`).expect(200);
    const list = await http().get('/api/v1/messages?kind=password_reset').expect(200);
    for (const body of [one.body, rec.body, list.body]) expect(JSON.stringify(body)).not.toContain(CODE);

    // The worker sends the real code.
    expect(await processor.process(r.id, 1, job!.data.sealedBody)).toBe('sent');
    expect(provider.deliveryLog).toHaveLength(1);
    expect(provider.deliveryLog[0]!.body).toContain(`your password reset code is ${CODE}. It expires in 30 minutes`);
    expect((await recipient(messageId)).body).not.toContain(CODE);
  });

  it('a resend without the encrypted text (for example "retry failed") sends nothing and explains why', async () => {
    const { messageId } = await notify.enqueue('password_reset', [{ phone: PHONE }], { code: CODE, minutes: 30 });
    const r = await recipient(messageId);
    expect(await processor.process(r.id, 1)).toBe('failed');
    expect(provider.deliveryLog).toHaveLength(0);
    expect((await recipient(messageId)).last_error).toMatch(/Ask for a new code/);
  });

  it('is sent at once in quiet hours (the code expires after 30 minutes)', async () => {
    clock(NIGHT);
    const { messageId } = await notify.enqueue('password_reset', [{ phone: PHONE }], { code: CODE, minutes: 30 });
    const r = await recipient(messageId);
    const [job] = await jobData(r.id);
    expect(new Date(job!.start_after).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await processor.process(r.id, 1, job!.data.sealedBody)).toBe('sent');
  });

  it('other templates are stored unchanged', async () => {
    const { messageId } = await notify.enqueue('announcement', [{ phone: PHONE }], { message: 'Sports day is on Friday' });
    expect((await recipient(messageId)).body).toContain('Sports day is on Friday');
  });
});
