// Agent D test helpers: boots the real AppModule with the REAL session resolver (no override) and creates users.
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '@sms/db-types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PasswordHasher } from '../../src/security/password-hasher';
import { currentTotp } from '../../src/security/totp';
import { FIELD_CRYPTO } from '../../src/security/field-crypto';
import type { FieldCryptoEngine } from '../../src/security/field-crypto.service';
import type { Role } from '../../src/security/permissions';

export const PASSWORD = 'mango tree by the lagoon';

export async function bootRealApp(dbUrl: string): Promise<{ app: INestApplication; db: Kysely<DB>; crypto: FieldCryptoEngine; close(): Promise<void> }> {
  process.env.SMS_DB_URL = dbUrl;
  process.env.SMS_NODE_ENV = 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
  // The test database is dropped WITH (FORCE) at teardown; ignore the server terminating a closing client (57P01).
  pool.on('error', () => {});
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const crypto = app.get<FieldCryptoEngine>(FIELD_CRYPTO);
  return { app, db, crypto, close: async () => { await db.destroy(); await app.close(); } };
}

const hasher = new PasswordHasher();

export async function createUser(db: Kysely<DB>, opts: { username: string; roles: Role[]; password?: string; mustChange?: boolean; mfaSecret?: string; crypto?: FieldCryptoEngine; staffId?: string | null }): Promise<string> {
  const r = await db.insertInto('users').values({
    username: opts.username,
    full_name: `Test ${opts.username}`,
    password_hash: await hasher.hash(opts.password ?? PASSWORD),
    roles: opts.roles,
    must_change_password: opts.mustChange ?? false,
    mfa_enabled: Boolean(opts.mfaSecret),
    mfa_secret_enc: opts.mfaSecret && opts.crypto ? opts.crypto.encrypt(opts.mfaSecret) : null,
    staff_id: opts.staffId ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

export function cookieFrom(res: request.Response): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((x) => x.startsWith('__Host-sms_session=') && !x.startsWith('__Host-sms_session=;'));
  return c ? c.split(';')[0]! : null;
}

export interface Session {
  cookie: string;
  csrf: string;
  body: Record<string, unknown>;
}

/** Logs in (and completes MFA when a secret is given). */
export async function login(app: INestApplication, username: string, password = PASSWORD, mfaSecret?: string): Promise<Session> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  let cookie = cookieFrom(res)!;
  let body = res.body as Record<string, unknown>;
  let csrf = (body.user as { csrfToken: string }).csrfToken;
  if (body.mfaRequired && mfaSecret) {
    const v = await request(app.getHttpServer()).post('/api/v1/auth/mfa/verify').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ code: currentTotp(mfaSecret) });
    if (v.status !== 200) throw new Error(`mfa failed ${v.status} ${JSON.stringify(v.body)}`);
    cookie = cookieFrom(v)!;
    body = v.body as Record<string, unknown>;
    csrf = body.csrfToken as string;
  }
  return { cookie, csrf, body };
}

export function authed(app: INestApplication, s: Session) {
  const agent = request(app.getHttpServer());
  return {
    get: (url: string) => agent.get(url).set('Cookie', s.cookie),
    post: (url: string) => agent.post(url).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf),
    patch: (url: string) => agent.patch(url).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf),
  };
}
