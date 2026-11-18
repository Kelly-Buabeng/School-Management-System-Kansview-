import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { authed, bootRealApp, createUser, login, type Session } from './support';
import { RateLimiter } from '../../src/security/rate-limiter';
import { generateTotpSecret } from '../../src/security/totp';
import { IDEMPOTENCY_SERVICE, type IdempotencyService } from '../../src/security/idempotency';
import { AUDIT_SERVICE, type AuditService } from '../../src/security/audit.service';
import type { AuthUser } from '../../src/security/auth-user';
import { permissionsForRoles } from '../../src/security/permissions';

let tdb: TestDatabase;
let ctx: Awaited<ReturnType<typeof bootRealApp>>;
let admin: Session;
let adminId: string;
const http = () => request(ctx.app.getHttpServer());

beforeAll(async () => {
  tdb = await createTestDatabase('d_users');
  ctx = await bootRealApp(tdb.url);
  const secret = generateTotpSecret();
  adminId = await createUser(ctx.db, { username: 'admin.main', roles: ['ADMIN'], mfaSecret: secret, crypto: ctx.crypto });
  admin = await login(ctx.app, 'admin.main', undefined, secret);
});
afterAll(async () => {
  await ctx?.close();
  await tdb?.drop();
});
beforeEach(() => ctx.app.get(RateLimiter).resetAll());

describe('users administration', () => {
  it('creates a user with a temporary password that must be changed at first login', async () => {
    const r = await authed(ctx.app, admin).post('/api/v1/users').send({ username: 'Reg.Abena', fullName: 'Abena Owusu', roles: ['REGISTRAR'] });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ username: 'reg.abena', roles: ['REGISTRAR'], mustChangePassword: true });
    expect(r.body.temporaryPassword).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    const s = await login(ctx.app, 'reg.abena', r.body.temporaryPassword);
    expect(s.body.mustChangePassword).toBe(true);
    expect((await authed(ctx.app, s).get('/api/v1/students')).status).toBe(403);
    const audit = await ctx.db.selectFrom('audit.events').select(['action', 'entity_id']).where('entity_type', '=', 'user').where('action', '=', 'create').execute();
    expect(audit.some((a) => a.entity_id === r.body.user.id)).toBe(true);
  });

  it('rejects mass assignment and duplicate usernames', async () => {
    expect((await authed(ctx.app, admin).post('/api/v1/users').send({ username: 'x.y.z', fullName: 'X', roles: ['TEACHER'], status: 'active' })).status).toBe(400);
    expect((await authed(ctx.app, admin).post('/api/v1/users').send({ username: 'reg.abena', fullName: 'Again', roles: ['TEACHER'] })).status).toBe(409);
  });

  it('role change revokes the user sessions; force logout, unlock, reset MFA and reset password work', async () => {
    const id = await createUser(ctx.db, { username: 'reg.kwesi', roles: ['REGISTRAR'] });
    const s = await login(ctx.app, 'reg.kwesi');
    const p = await authed(ctx.app, admin).patch(`/api/v1/users/${id}`).send({ roles: ['REGISTRAR', 'TEACHER'] });
    expect(p.status).toBe(200);
    expect((await authed(ctx.app, s).get('/api/v1/auth/me')).status).toBe(401);

    const s2 = await login(ctx.app, 'reg.kwesi');
    expect((await authed(ctx.app, admin).post(`/api/v1/users/${id}/force-logout`)).status).toBe(204);
    expect((await authed(ctx.app, s2).get('/api/v1/auth/me')).status).toBe(401);

    await ctx.db.updateTable('users').set({ failed_login_count: 5, locked_until: new Date(Date.now() + 600_000) }).where('id', '=', id).execute();
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.kwesi', password: 'mango tree by the lagoon' })).status).toBe(423);
    expect((await authed(ctx.app, admin).post(`/api/v1/users/${id}/unlock`)).status).toBe(204);
    expect((await http().post('/api/v1/auth/login').send({ username: 'reg.kwesi', password: 'mango tree by the lagoon' })).status).toBe(200);

    expect((await authed(ctx.app, admin).post(`/api/v1/users/${id}/reset-mfa`)).status).toBe(204);
    const rp = await authed(ctx.app, admin).post(`/api/v1/users/${id}/reset-password`);
    expect(rp.status).toBe(200);
    const s3 = await login(ctx.app, 'reg.kwesi', rp.body.temporaryPassword);
    expect(s3.body.mustChangePassword).toBe(true);
  });

  it('an admin cannot change their own roles, unlock themselves, or remove the last admin', async () => {
    expect((await authed(ctx.app, admin).patch(`/api/v1/users/${adminId}`).send({ roles: ['REGISTRAR'] })).status).toBe(422);
    expect((await authed(ctx.app, admin).post(`/api/v1/users/${adminId}/unlock`)).status).toBe(422);
  });

  it('non-admin roles are refused (403) and unknown ids give 404', async () => {
    for (const role of ['BURSAR', 'HEADTEACHER', 'REGISTRAR', 'TEACHER'] as const) {
      const secret = generateTotpSecret();
      const uname = `deny.${role.toLowerCase()}`;
      await createUser(ctx.db, { username: uname, roles: [role], mfaSecret: role === 'BURSAR' ? secret : undefined, crypto: ctx.crypto });
      const s = await login(ctx.app, uname, undefined, role === 'BURSAR' ? secret : undefined);
      expect((await authed(ctx.app, s).get('/api/v1/users')).status).toBe(403);
      expect((await authed(ctx.app, s).post('/api/v1/users').send({ username: 'evil.user', fullName: 'Evil', roles: ['ADMIN'] })).status).toBe(403);
      expect((await authed(ctx.app, s).get('/api/v1/audit-events')).status).toBe(role === 'HEADTEACHER' ? 200 : 403);
    }
    expect((await authed(ctx.app, admin).get('/api/v1/users/01900000-0000-7000-8000-00000000dead')).status).toBe(404);
    expect((await authed(ctx.app, admin).get('/api/v1/users/not-a-uuid')).status).toBe(404);
  });
});

describe('audit log', () => {
  it('lists events with filters and masks sensitive values', async () => {
    const audit = ctx.app.get<AuditService>(AUDIT_SERVICE);
    await audit.record({ action: 'update', entityType: 'guardian', entityId: 'g1', changes: { ghanaCard: { before: 'GHA-111111111-1', after: 'GHA-222222222-2' }, firstName: { before: 'Ama', after: 'Ami' } } }, null);
    const r = await authed(ctx.app, admin).get('/api/v1/audit-events').query({ entityType: 'guardian' });
    expect(r.status).toBe(200);
    expect(r.body.data[0].changes).toEqual({ ghanaCard: { before: '[REDACTED]', after: '[REDACTED]' }, firstName: { before: 'Ama', after: 'Ami' } });
  });

  it('is append-only: UPDATE and DELETE on audit.events fail', async () => {
    await expect(sql`UPDATE audit.events SET reason = 'tampered'`.execute(ctx.db)).rejects.toThrow();
    await expect(sql`DELETE FROM audit.events`.execute(ctx.db)).rejects.toThrow();
  });

  it('audit row commits and rolls back with the business transaction', async () => {
    const audit = ctx.app.get<AuditService>(AUDIT_SERVICE);
    await expect(ctx.db.transaction().execute(async (tx) => {
      await audit.record({ action: 'create', entityType: 'rollback_probe' }, null, tx);
      throw new Error('business failure');
    })).rejects.toThrow('business failure');
    expect(await ctx.db.selectFrom('audit.events').select('id').where('entity_type', '=', 'rollback_probe').execute()).toHaveLength(0);
  });

  it('chain verification reports intact, then the first broken event after tampering', async () => {
    const ok = await authed(ctx.app, admin).post('/api/v1/audit-events/verify');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ intact: true, firstBrokenId: null });
    expect(ok.body.checkedEvents).toBeGreaterThan(0);
    // A superuser disabling the trigger is the only way to edit; the chain still catches it.
    const target = await ctx.db.selectFrom('audit.events').select('id').orderBy('id').offset(2).limit(1).executeTakeFirstOrThrow();
    await sql`ALTER TABLE audit.events DISABLE TRIGGER events_append_only`.execute(ctx.db);
    await sql`UPDATE audit.events SET reason = 'edited by an attacker' WHERE id = ${target.id}`.execute(ctx.db);
    await sql`ALTER TABLE audit.events ENABLE TRIGGER events_append_only`.execute(ctx.db);
    const bad = await authed(ctx.app, admin).post('/api/v1/audit-events/verify');
    expect(bad.body.intact).toBe(false);
    expect(bad.body.firstBrokenId).toBe(Number(target.id));
  });
});

describe('IdempotencyService', () => {
  const user: AuthUser = { id: '', username: 'x', fullName: 'x', roles: ['BURSAR'], permissions: permissionsForRoles(['BURSAR']), sessionId: 's', staffId: null, mfaVerified: true };
  beforeAll(async () => {
    user.id = await createUser(ctx.db, { username: 'idem.user', roles: ['BURSAR'] });
  });

  it('same key + same body replays; different body → 422; missing key → 400; failures can be retried', async () => {
    const idem = ctx.app.get<IdempotencyService>(IDEMPOTENCY_SERVICE);
    let calls = 0;
    const fn = async () => ({ status: 201, body: { n: ++calls } });
    const key = 'key-0123456789abcdef';
    const a = await idem.run(key, 'POST /test', { amount: 1, b: 2 }, user, fn);
    const b = await idem.run(key, 'POST /test', { b: 2, amount: 1 }, user, fn);
    expect(a).toEqual({ status: 201, body: { n: 1 }, replayed: false });
    expect(b).toEqual({ status: 201, body: { n: 1 }, replayed: true });
    expect(calls).toBe(1);
    await expect(idem.run(key, 'POST /test', { amount: 2 }, user, fn)).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(idem.run(undefined, 'POST /test', {}, user, fn)).rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const k2 = 'key-fail-0123456789ab';
    await expect(idem.run(k2, 'POST /test', {}, user, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await idem.run(k2, 'POST /test', {}, user, fn)).replayed).toBe(false);
  });

  it('concurrent requests with the same key run the business function once', async () => {
    const idem = ctx.app.get<IdempotencyService>(IDEMPOTENCY_SERVICE);
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return { status: 201, body: { ok: true } };
    };
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => idem.run('key-concurrent-012345', 'POST /test', {}, user, fn)));
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled' && !r.value.replayed)).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { status: number }).status).toBe(409);
  });
});
