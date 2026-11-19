// Owner: Agent H. Signed-in API client for e2e specs: real login (+ TOTP for ADMIN/BURSAR), session cookie and
// CSRF header handled explicitly, so specs read like the OpenAPI contract.
import { randomUUID } from 'node:crypto';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { totp } from './totp';

export const WEB_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? '4300'}`;

/** Dev sign-ins created by db/seeds/seed.mjs (fake, development only). */
export const USERS = {
  admin: { username: 'admin', password: 'Kansview-Admin-Dev-2026!', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' },
  bursar: { username: 'bursar', password: 'Kansview-Bursar-Dev-2026!', totpSecret: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU' },
  head: { username: 'head', password: 'Kansview-Head-Dev-2026!' },
  registrar: { username: 'registrar', password: 'Kansview-Registrar-Dev-2026!' },
  teacher: { username: 'teacher.p1a', password: 'Kansview-Teacher-Dev-2026!' },
  teacherP4b: { username: 'teacher.p4b', password: 'Kansview-Teacher-Dev-2026!' },
} as const satisfies Record<string, { username: string; password: string; totpSecret?: string }>;
export type UserKey = keyof typeof USERS;

export const idemKey = (): string => `e2e-${randomUUID()}`;

function sessionCookie(res: APIResponse): string | null {
  const c = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value)
    .find((v) => v.startsWith('__Host-sms_session=') && !v.startsWith('__Host-sms_session=;'));
  return c ? c.split(';')[0]! : null;
}

export class ApiSession {
  private constructor(private readonly ctx: APIRequestContext, private cookie: string, private csrf: string, readonly user: Record<string, unknown>) {}

  static async signIn(who: UserKey): Promise<ApiSession> {
    const u = USERS[who];
    const ctx = await request.newContext({ baseURL: WEB_ORIGIN });
    const res = await ctx.post('/api/v1/auth/login', { data: { username: u.username, password: u.password } });
    if (res.status() !== 200) throw new Error(`login ${who} failed: ${res.status()} ${await res.text()}`);
    let body = (await res.json()) as { mfaRequired?: boolean; user: { csrfToken: string } & Record<string, unknown> };
    let cookie = sessionCookie(res)!;
    let csrf = body.user.csrfToken;
    let user = body.user as Record<string, unknown>;
    if (body.mfaRequired) {
      if (!('totpSecret' in u)) throw new Error(`${who} needs MFA but has no TOTP secret`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = await ctx.post('/api/v1/auth/mfa/verify', { headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, data: { code: totp(u.totpSecret) } });
        if (v.status() === 200) {
          cookie = sessionCookie(v) ?? cookie;
          const vb = (await v.json()) as { csrfToken: string } & Record<string, unknown>;
          csrf = vb.csrfToken;
          user = vb;
          break;
        }
        if (attempt === 1) throw new Error(`MFA for ${who} failed: ${v.status()} ${await v.text()}`);
        // A code can be used only once: wait for the next 30-second window.
        await new Promise((r) => setTimeout(r, 31_000 - (Date.now() % 30_000)));
      }
    }
    void body;
    return new ApiSession(ctx, cookie, csrf, user);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Cookie: this.cookie, 'X-CSRF-Token': this.csrf, ...extra };
  }

  get(path: string, params?: Record<string, string | number | boolean>): Promise<APIResponse> {
    return this.ctx.get(`/api/v1${path}`, { headers: this.headers(), params });
  }
  post(path: string, data?: unknown, opts: { idempotencyKey?: string; headers?: Record<string, string> } = {}): Promise<APIResponse> {
    const h = this.headers({ ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}), ...opts.headers });
    return this.ctx.post(`/api/v1${path}`, { headers: h, data: data ?? {} });
  }
  put(path: string, data: unknown, headers?: Record<string, string>): Promise<APIResponse> {
    return this.ctx.put(`/api/v1${path}`, { headers: this.headers(headers), data });
  }
  patch(path: string, data: unknown, headers?: Record<string, string>): Promise<APIResponse> {
    return this.ctx.patch(`/api/v1${path}`, { headers: this.headers(headers), data });
  }
  async json<T = any>(res: Promise<APIResponse> | APIResponse, expected = 200): Promise<T> {
    const r = await res;
    if (r.status() !== expected) throw new Error(`${r.url()} → ${r.status()} (expected ${expected}): ${await r.text()}`);
    return (await r.json()) as T;
  }
  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}
