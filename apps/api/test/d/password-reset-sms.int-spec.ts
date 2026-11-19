// CP5-06: self-service password reset by SMS. The code must actually be in the SMS (it was blank: the auth module
// sent "resetCode" while the template uses {{code}}), and it must work to reset the password.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { bootRealApp, createUser } from './support';
import { renderTemplate } from '../../src/modules/notifications/template-engine';
import { DEFAULT_TEMPLATE_BODIES } from '../../src/modules/notifications/notification.service';
import { DeliveryProcessor } from '../../src/modules/notifications/delivery.processor';
import { MessageDispatcher } from '../../src/modules/notifications/message-dispatcher';
import { NotificationsWorker } from '../../src/modules/notifications/notifications.worker';
import { MESSAGE_PROVIDER } from '../../src/modules/notifications/providers/message-provider';
import type { MockProvider } from '../../src/modules/notifications/providers/mock.provider';

let tdb: TestDatabase;
let ctx: Awaited<ReturnType<typeof bootRealApp>>;
const http = () => request(ctx.app.getHttpServer());
const DAYTIME = new Date('2026-11-18T10:00:00Z');

beforeAll(async () => {
  tdb = await createTestDatabase('d_reset_sms');
  ctx = await bootRealApp(tdb.url);
  // Fixed school-day clock so quiet hours never delay the SMS, whatever time the test runs.
  ctx.app.get(DeliveryProcessor).now = () => DAYTIME;
  ctx.app.get(MessageDispatcher).now = () => DAYTIME;
});
afterAll(async () => {
  await ctx?.close();
  await tdb?.drop();
});

async function waitFor<T>(fn: () => T, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('password reset SMS (CP5-06)', () => {
  it('the default template has every placeholder the reset sends', () => {
    const { missing } = renderTemplate(DEFAULT_TEMPLATE_BODIES.password_reset, { schoolName: 'Kansview', code: 'abc', minutes: 30 });
    expect(missing).toEqual([]);
  });

  it('the SMS carries the code, and that code resets the password', async () => {
    const staff = await ctx.db.insertInto('staff').values({ staff_code: 'STF-D61', first_name: 'Efua', last_name: 'Boateng', staff_type: 'non_teaching', phone: '+233244000661' })
      .returning('id').executeTakeFirstOrThrow();
    await createUser(ctx.db, { username: 'reg.efua', roles: ['REGISTRAR'], staffId: staff.id });
    const provider = ctx.app.get<MockProvider>(MESSAGE_PROVIDER);
    provider.reset();
    await ctx.app.get(NotificationsWorker).start({ pollingIntervalSeconds: 0.5 });

    expect((await http().post('/api/v1/auth/password/reset-request').send({ username: 'reg.efua' })).status).toBe(202);
    const [sms] = await waitFor(() => provider.deliveryLog, (l) => l.length > 0);
    expect(sms!.to).toBe('+233244000661');
    const code = /reset code is (\S+)\. It expires in 30 minutes/.exec(sms!.body)?.[1];
    expect(code, `SMS was: ${sms!.body}`).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect((await http().post('/api/v1/auth/password/reset').send({ token: code, newPassword: 'cocoa farm near kumasi' })).status).toBe(204);
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.efua', password: 'cocoa farm near kumasi' })).status).toBe(200);
  });
});
