import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { authenticator } from 'otplib';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { authed, bootRealApp, cookieFrom, createUser, login, PASSWORD } from './support';
import { RateLimiter } from '../../src/security/rate-limiter';
import { currentTotp, generateTotpSecret } from '../../src/security/totp';

let tdb: TestDatabase;
let ctx: Awaited<ReturnType<typeof bootRealApp>>;
const http = () => request(ctx.app.getHttpServer());

beforeAll(async () => {
  tdb = await createTestDatabase('d_auth');
  ctx = await bootRealApp(tdb.url);
});
afterAll(async () => {
  await ctx?.close();
  await tdb?.drop();
});
beforeEach(() => ctx.app.get(RateLimiter).resetAll());

const events = (action: string) => ctx.db.selectFrom('audit.events').selectAll().where('action', '=', action).execute();

describe('login', () => {
  it('signs in, sets a hardened session cookie, and /auth/me works', async () => {
    const id = await createUser(ctx.db, { username: 'reg.ama', roles: ['REGISTRAR'] });
    const res = await http().post('/api/v1/auth/login').send({ username: 'Reg.Ama', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mfaRequired: false, mfaEnrolmentRequired: false, mustChangePassword: false, user: { id, roles: ['REGISTRAR'], sessionPhase: 'full' } });
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(setCookie).toMatch(/^__Host-sms_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);

    const cookie = cookieFrom(res)!;
    const me = await http().get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('students:create');
    expect(me.body.csrfToken).toBe(res.body.user.csrfToken);

    // only the hash of the session id is stored
    const raw = cookie.split('=')[1]!;
    const rows = await ctx.db.selectFrom('user_sessions').select('id').where('user_id', '=', id).execute();
    expect(rows.map((r) => r.id)).toEqual([createHash('sha256').update(raw).digest('hex')]);
    expect((await events('login')).some((e) => e.actor_user_id === id)).toBe(true);
  });

  it('gives the same answer for an unknown user and a wrong password (no enumeration)', async () => {
    await createUser(ctx.db, { username: 'reg.kofi', roles: ['REGISTRAR'] });
    const a = await http().post('/api/v1/auth/login').send({ username: 'reg.kofi', password: 'wrong password here' });
    const b = await http().post('/api/v1/auth/login').send({ username: 'nobody.here', password: 'wrong password here' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const strip = (x: Record<string, unknown>) => ({ ...x, requestId: undefined });
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(a.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect((await events('login_failed')).length).toBeGreaterThanOrEqual(2);
  });

  it('locks the account after 5 failures for 15 minutes, even with the right password', async () => {
    const id = await createUser(ctx.db, { username: 'reg.esi', roles: ['REGISTRAR'] });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await http().post('/api/v1/auth/login').send({ username: 'reg.esi', password: `wrong guess ${i}` })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 423]);
    const right = await http().post('/api/v1/auth/login').send({ username: 'reg.esi', password: PASSWORD });
    expect(right.status).toBe(423);
    expect(right.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    const u = await ctx.db.selectFrom('users').select(['locked_until', 'failed_login_count']).where('id', '=', id).executeTakeFirstOrThrow();
    const mins = (new Date(u.locked_until!).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(14);
    expect(mins).toBeLessThanOrEqual(15);

    // after the lock expires the right password works and resets the counter
    await ctx.db.updateTable('users').set({ locked_until: new Date(Date.now() - 1000) }).where('id', '=', id).execute();
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.esi', password: PASSWORD })).status).toBe(200);
  });

  it('lockout is progressive (second lockout lasts 30 minutes)', async () => {
    const id = await createUser(ctx.db, { username: 'reg.yaw', roles: ['REGISTRAR'] });
    await ctx.db.updateTable('users').set({ failed_login_count: 9 }).where('id', '=', id).execute();
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.yaw', password: 'wrong guess again' })).status).toBe(423);
    const u = await ctx.db.selectFrom('users').select('locked_until').where('id', '=', id).executeTakeFirstOrThrow();
    expect((new Date(u.locked_until!).getTime() - Date.now()) / 60_000).toBeGreaterThan(29);
  });

  it('unknown usernames also "lock" after 5 tries, so lockout does not reveal accounts', async () => {
    const s: number[] = [];
    for (let i = 0; i < 6; i++) s.push((await http().post('/api/v1/auth/login').send({ username: 'ghost.user', password: `wrong guess ${i}` })).status);
    expect(s.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(s[5]).toBe(423);
  });

  it('rate limits login attempts per IP and username (429 with Retry-After)', async () => {
    let last: request.Response | undefined;
    for (let i = 0; i < 11; i++) last = await http().post('/api/v1/auth/login').send({ username: 'ghost.rl', password: 'x' });
    expect(last!.status).toBe(429);
    expect(last!.headers['retry-after']).toBeDefined();
  });

  it('successful sign-ins from one address do not use up the per-address limit; failures still do (CP5-02)', async () => {
    await createUser(ctx.db, { username: 'reg.staffroom', roles: ['REGISTRAR'] });
    const ok: number[] = [];
    // a whole staffroom behind one address signing in on a Monday morning
    for (let i = 0; i < 55; i++) ok.push((await http().post('/api/v1/auth/login').send({ username: 'reg.staffroom', password: PASSWORD })).status);
    expect(ok.filter((s) => s !== 200)).toEqual([]);
    // 50 failed logins with different usernames from the same address still trip the per-address limit
    const bad: number[] = [];
    for (let i = 0; i < 51; i++) bad.push((await http().post('/api/v1/auth/login').send({ username: `ghost.wifi${i}`, password: 'wrong guess' })).status);
    expect(bad.slice(0, 50).filter((s) => s === 429)).toEqual([]);
    expect(bad[50]).toBe(429);
  });

  it('rejects unknown fields (strict body) and disabled accounts', async () => {
    expect((await http().post('/api/v1/auth/login').send({ username: 'a', password: 'b', roles: ['ADMIN'] })).status).toBe(400);
    await createUser(ctx.db, { username: 'reg.off', roles: ['REGISTRAR'] });
    await ctx.db.updateTable('users').set({ status: 'disabled' }).where('username', '=', 'reg.off').execute();
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.off', password: PASSWORD })).status).toBe(403);
  });

  it('replaces any session presented at login (session fixation)', async () => {
    await createUser(ctx.db, { username: 'reg.fix', roles: ['REGISTRAR'] });
    const first = await login(ctx.app, 'reg.fix');
    const second = await http().post('/api/v1/auth/login').set('Cookie', first.cookie).send({ username: 'reg.fix', password: PASSWORD });
    expect(cookieFrom(second)).not.toBe(first.cookie);
    expect((await http().get('/api/v1/auth/me').set('Cookie', first.cookie)).status).toBe(401);
  });
});

describe('CSRF', () => {
  it('refuses state-changing requests without the right X-CSRF-Token', async () => {
    await createUser(ctx.db, { username: 'reg.csrf', roles: ['REGISTRAR'] });
    const s = await login(ctx.app, 'reg.csrf');
    const none = await http().post('/api/v1/auth/logout').set('Cookie', s.cookie);
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('CSRF_INVALID');
    const wrong = await http().post('/api/v1/auth/logout').set('Cookie', s.cookie).set('X-CSRF-Token', 'x'.repeat(43));
    expect(wrong.status).toBe(403);
    expect((await authed(ctx.app, s).post('/api/v1/auth/logout')).status).toBe(204);
  });

  it("another session's token does not work", async () => {
    await createUser(ctx.db, { username: 'reg.csrf2', roles: ['REGISTRAR'] });
    await createUser(ctx.db, { username: 'reg.csrf3', roles: ['REGISTRAR'] });
    const a = await login(ctx.app, 'reg.csrf2');
    const b = await login(ctx.app, 'reg.csrf3');
    expect((await http().post('/api/v1/auth/logout').set('Cookie', a.cookie).set('X-CSRF-Token', b.csrf)).status).toBe(403);
  });
});

describe('sessions', () => {
  it('logout revokes the session', async () => {
    await createUser(ctx.db, { username: 'reg.out', roles: ['REGISTRAR'] });
    const s = await login(ctx.app, 'reg.out');
    const r = await authed(ctx.app, s).post('/api/v1/auth/logout');
    expect(r.status).toBe(204);
    expect(String(r.headers['set-cookie'])).toMatch(/__Host-sms_session=;/);
    expect((await authed(ctx.app, s).get('/api/v1/auth/me')).status).toBe(401);
    expect((await events('logout')).length).toBeGreaterThan(0);
  });

  it('idle timeout (30 min) and absolute timeout (12 h) end the session', async () => {
    const id = await createUser(ctx.db, { username: 'reg.idle', roles: ['REGISTRAR'] });
    const s1 = await login(ctx.app, 'reg.idle');
    const row = await ctx.db.selectFrom('user_sessions').select(['idle_expires_at', 'expires_at', 'created_at']).where('user_id', '=', id).executeTakeFirstOrThrow();
    expect(Math.round((new Date(row.idle_expires_at).getTime() - new Date(row.created_at).getTime()) / 60_000)).toBe(30);
    expect(Math.round((new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 3_600_000)).toBe(12);
    await ctx.db.updateTable('user_sessions').set({ idle_expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', id).execute();
    const r = await authed(ctx.app, s1).get('/api/v1/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_SESSION_EXPIRED');

    const s2 = await login(ctx.app, 'reg.idle');
    await ctx.db.updateTable('user_sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
    expect((await authed(ctx.app, s2).get('/api/v1/auth/me')).status).toBe(401);
  });

  it('activity slides the idle timeout', async () => {
    const id = await createUser(ctx.db, { username: 'reg.slide', roles: ['REGISTRAR'] });
    const s = await login(ctx.app, 'reg.slide');
    await ctx.db.updateTable('user_sessions').set({ idle_expires_at: new Date(Date.now() + 60_000) }).where('user_id', '=', id).execute();
    await authed(ctx.app, s).get('/api/v1/auth/me');
    const row = await ctx.db.selectFrom('user_sessions').select('idle_expires_at').where('user_id', '=', id).executeTakeFirstOrThrow();
    expect(new Date(row.idle_expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  });
});

describe('MFA', () => {
  it('ADMIN without MFA must enrol before anything else; enrolment returns one-time recovery codes', async () => {
    await createUser(ctx.db, { username: 'admin.enrol', roles: ['ADMIN'] });
    const s = await login(ctx.app, 'admin.enrol');
    expect(s.body.mfaEnrolmentRequired).toBe(true);
    const blocked = await authed(ctx.app, s).get('/api/v1/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('AUTH_MFA_ENROLMENT_REQUIRED');
    expect((await authed(ctx.app, s).get('/api/v1/auth/me')).body.sessionPhase).toBe('mfa_enrolment');

    const setup = await authed(ctx.app, s).post('/api/v1/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const bad = await authed(ctx.app, s).post('/api/v1/auth/mfa/enable').send({ code: '000000' === currentTotp(setup.body.secret) ? '111111' : '000000' });
    expect(bad.status).toBe(401);
    const en = await authed(ctx.app, s).post('/api/v1/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) });
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);
    const newCookie = cookieFrom(en)!;
    expect(newCookie).not.toBe(s.cookie); // rotated
    expect((await http().get('/api/v1/users').set('Cookie', newCookie)).status).toBe(200);
    const u = await ctx.db.selectFrom('users').select(['mfa_recovery_codes_hash', 'mfa_secret_enc']).where('username', '=', 'admin.enrol').executeTakeFirstOrThrow();
    expect(u.mfa_recovery_codes_hash!.join()).not.toContain(en.body.recoveryCodes[0].replace(/-/g, ''));
    expect(u.mfa_secret_enc!.toString('latin1')).not.toContain(setup.body.secret);
  });

  it('with MFA on, the password step only allows MFA verify / me / logout; verify rotates the session', async () => {
    const secret = generateTotpSecret();
    await createUser(ctx.db, { username: 'bursar.mfa', roles: ['BURSAR'], mfaSecret: secret, crypto: ctx.crypto });
    const res = await http().post('/api/v1/auth/login').send({ username: 'bursar.mfa', password: PASSWORD });
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.user.permissions).toEqual([]);
    const cookie = cookieFrom(res)!;
    const csrf = res.body.user.csrfToken;
    const blocked = await http().get('/api/v1/users').set('Cookie', cookie);
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('AUTH_MFA_REQUIRED');
    expect((await http().post('/api/v1/auth/mfa/setup').set('Cookie', cookie).set('X-CSRF-Token', csrf)).status).toBe(401);

    const wrong = await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ code: currentTotp(secret) === '123456' ? '654321' : '123456' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('AUTH_MFA_INVALID');

    const ok = await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ code: currentTotp(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.permissions).toContain('payments:create');
    const rotated = cookieFrom(ok)!;
    expect(rotated).not.toBe(cookie);
    expect((await http().get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await http().get('/api/v1/auth/me').set('Cookie', rotated)).status).toBe(200);
  });

  it('a TOTP code cannot be replayed and recovery codes work once', async () => {
    const secret = generateTotpSecret();
    const id = await createUser(ctx.db, { username: 'head.mfa', roles: ['HEADTEACHER'], mfaSecret: secret, crypto: ctx.crypto });
    const code = currentTotp(secret);
    const s1 = await http().post('/api/v1/auth/login').send({ username: 'head.mfa', password: PASSWORD });
    expect((await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookieFrom(s1)!).set('X-CSRF-Token', s1.body.user.csrfToken).send({ code })).status).toBe(200);
    const s2 = await http().post('/api/v1/auth/login').send({ username: 'head.mfa', password: PASSWORD });
    const replay = await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookieFrom(s2)!).set('X-CSRF-Token', s2.body.user.csrfToken).send({ code });
    expect(replay.status).toBe(401);

    const { hashRecoveryCode } = await import('../../src/security/totp');
    await ctx.db.updateTable('users').set({ mfa_recovery_codes_hash: [hashRecoveryCode('abcd-efgh-jkmn')], failed_login_count: 0 }).where('id', '=', id).execute();
    const s3 = await http().post('/api/v1/auth/login').send({ username: 'head.mfa', password: PASSWORD });
    expect((await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookieFrom(s3)!).set('X-CSRF-Token', s3.body.user.csrfToken).send({ code: 'ABCD-EFGH-JKMN' })).status).toBe(200);
    const s4 = await http().post('/api/v1/auth/login').send({ username: 'head.mfa', password: PASSWORD });
    expect((await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookieFrom(s4)!).set('X-CSRF-Token', s4.body.user.csrfToken).send({ code: 'abcd-efgh-jkmn' })).status).toBe(401);
  });

  it('ADMIN/BURSAR cannot disable MFA; others can with their password', async () => {
    const secret = generateTotpSecret();
    await createUser(ctx.db, { username: 'bursar.dis', roles: ['BURSAR'], mfaSecret: secret, crypto: ctx.crypto });
    const s = await login(ctx.app, 'bursar.dis', PASSWORD, secret);
    const r = await authed(ctx.app, s).post('/api/v1/auth/mfa/disable').send({ password: PASSWORD });
    expect(r.status).toBe(422);
    const secret2 = generateTotpSecret();
    await createUser(ctx.db, { username: 'reg.dis', roles: ['REGISTRAR'], mfaSecret: secret2, crypto: ctx.crypto });
    const s2 = await login(ctx.app, 'reg.dis', PASSWORD, secret2);
    expect((await authed(ctx.app, s2).post('/api/v1/auth/mfa/disable').send({ password: PASSWORD })).status).toBe(204);
  });

  it('wrong MFA codes count towards lockout', async () => {
    const secret = generateTotpSecret();
    await createUser(ctx.db, { username: 'reg.mfalock', roles: ['REGISTRAR'], mfaSecret: secret, crypto: ctx.crypto });
    const res = await http().post('/api/v1/auth/login').send({ username: 'reg.mfalock', password: PASSWORD });
    const wrongCode = authenticator.clone({ epoch: Date.now() - 3_600_000 }).generate(secret);
    const s: number[] = [];
    for (let i = 0; i < 5; i++) {
      s.push((await http().post('/api/v1/auth/mfa/verify').set('Cookie', cookieFrom(res)!).set('X-CSRF-Token', res.body.user.csrfToken).send({ code: wrongCode })).status);
    }
    expect(s).toEqual([401, 401, 401, 401, 423]);
  });
});

describe('passwords', () => {
  it('temporary password must be changed first; change revokes other sessions; weak passwords refused', async () => {
    await createUser(ctx.db, { username: 'reg.temp', roles: ['REGISTRAR'], mustChange: true });
    const a = await login(ctx.app, 'reg.temp');
    const b = await login(ctx.app, 'reg.temp');
    expect(a.body.mustChangePassword).toBe(true);
    expect((await authed(ctx.app, a).get('/api/v1/audit-events')).status).toBe(403);
    const weak = await authed(ctx.app, a).post('/api/v1/auth/password/change').send({ currentPassword: PASSWORD, newPassword: 'password1234' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('AUTH_PASSWORD_TOO_WEAK');
    const ok = await authed(ctx.app, a).post('/api/v1/auth/password/change').send({ currentPassword: PASSWORD, newPassword: 'blue canoe on lake volta' });
    expect(ok.status).toBe(204);
    expect((await authed(ctx.app, a).get('/api/v1/auth/me')).body.sessionPhase).toBe('full');
    expect((await authed(ctx.app, b).get('/api/v1/auth/me')).status).toBe(401);
  });

  it('reset request always answers 202 (no enumeration)', async () => {
    await createUser(ctx.db, { username: 'reg.reset0', roles: ['REGISTRAR'] });
    const a = await http().post('/api/v1/auth/password/reset-request').send({ username: 'reg.reset0' });
    const b = await http().post('/api/v1/auth/password/reset-request').send({ username: 'nobody.at.all' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
  });

  it('reset token works once, expires, and revokes sessions', async () => {
    const id = await createUser(ctx.db, { username: 'reg.reset', roles: ['REGISTRAR'] });
    const s = await login(ctx.app, 'reg.reset');
    const token = 'known-test-token-0123456789abcdef';
    await ctx.db.insertInto('password_reset_tokens').values({ user_id: id, token_hash: createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + 600_000) }).execute();
    const r1 = await http().post('/api/v1/auth/password/reset').send({ token, newPassword: 'red kente cloth market' });
    expect(r1.status).toBe(204);
    const r2 = await http().post('/api/v1/auth/password/reset').send({ token, newPassword: 'another fine passphrase' });
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('AUTH_RESET_TOKEN_INVALID');
    expect((await authed(ctx.app, s).get('/api/v1/auth/me')).status).toBe(401);
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.reset', password: 'red kente cloth market' })).status).toBe(200);

    const expired = 'expired-test-token-0123456789abcd';
    await ctx.db.insertInto('password_reset_tokens').values({ user_id: id, token_hash: createHash('sha256').update(expired).digest('hex'), expires_at: sql<Date>`now() - interval '1 minute'` }).execute();
    expect((await http().post('/api/v1/auth/password/reset').send({ token: expired, newPassword: 'red kente cloth market two' })).status).toBe(400);
  });
});

describe('rate limits on expensive reads', () => {
  it('search is limited per user (429 after the limit)', async () => {
    await createUser(ctx.db, { username: 'reg.search', roles: ['REGISTRAR'] });
    const s = await login(ctx.app, 'reg.search');
    const limiter = ctx.app.get(RateLimiter);
    const user = await ctx.db.selectFrom('users').select('id').where('username', '=', 'reg.search').executeTakeFirstOrThrow();
    for (let i = 0; i < 120; i++) limiter.consume(`search:${user.id}`, { limit: 120, windowMs: 60_000 });
    const r = await authed(ctx.app, s).get('/api/v1/search?q=ama');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });
});

describe('security headers', () => {
  it('sets strict headers on API responses', async () => {
    const r = await http().get('/api/v1/health/live');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
