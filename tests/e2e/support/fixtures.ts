// Owner: Agent H. `api.as('bursar')` gives a signed-in API session (one per role per worker, reused across tests).
import { test as base, expect, type Page } from '@playwright/test';
import { ApiSession, USERS, type UserKey } from './api';

interface ApiPool {
  as(who: UserKey): Promise<ApiSession>;
}

export const test = base.extend<{ signIn: (page: Page, who: UserKey) => Promise<void> }, { api: ApiPool }>({
  api: [
    async ({}, use) => {
      const sessions = new Map<UserKey, Promise<ApiSession>>();
      await use({
        as(who) {
          if (!sessions.has(who)) sessions.set(who, ApiSession.signIn(who));
          return sessions.get(who)!;
        },
      });
      for (const s of sessions.values()) await (await s).dispose();
    },
    { scope: 'worker' },
  ],
  signIn: async ({}, use) => {
    await use(async (page, who) => {
      const u = USERS[who];
      await page.goto('/');
      await page.getByLabel('Username').fill(u.username);
      await page.getByLabel('Password').fill(u.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.locator('#main h1')).toBeVisible();
    });
  },
});
export { expect };
