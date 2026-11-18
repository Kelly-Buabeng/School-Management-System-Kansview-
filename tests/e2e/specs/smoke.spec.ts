// Owner: Agent H. The stack is up, sign-in works through the same-origin proxy, RBAC holds on the real API.
import { test, expect } from '../support/fixtures';

test('health endpoints answer through the web origin', async ({ request }) => {
  await expect(await request.get('/api/v1/health/live')).toBeOK();
  await expect(await request.get('/api/v1/health/ready')).toBeOK();
});

test('registrar signs in through the UI and lands on the dashboard', async ({ page, signIn }) => {
  await signIn(page, 'registrar');
  await expect(page.locator('#main h1')).toBeVisible();
});

test('only ADMIN may read system status', async ({ api }) => {
  const admin = await api.as('admin');
  const status = await admin.json(admin.get('/system/status'));
  expect(status).toHaveProperty('backup');
  const bursar = await api.as('bursar');
  expect((await bursar.get('/system/status')).status()).toBe(403);
});
