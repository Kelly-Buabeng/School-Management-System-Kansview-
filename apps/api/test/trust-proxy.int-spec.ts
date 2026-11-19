// CP5-02: behind Caddy the API must see the real client address, not Caddy's, and must not believe a
// client-supplied X-Forwarded-For when no proxy is trusted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '@sms/db-types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { TrustProxySetting } from '../src/common/trust-proxy';
import { RateLimiter } from '../src/security/rate-limiter';
import { createTestDatabase, type TestDatabase } from './support/test-db';

let tdb: TestDatabase;
let db: Kysely<DB>;

async function boot(trust: TrustProxySetting): Promise<INestApplication> {
  process.env.SMS_DB_URL = tdb.url;
  process.env.SMS_NODE_ENV = 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }), trust);
  await app.init();
  app.get(RateLimiter).resetAll();
  return app;
}

const attemptIps = async (username: string) =>
  (await db.selectFrom('login_attempts').select('ip').where('username_tried', '=', username).execute()).map((r) => r.ip);

beforeAll(async () => {
  tdb = await createTestDatabase('trust_proxy');
  const pool = new pg.Pool({ connectionString: tdb.url, max: 2 });
  pool.on('error', () => {});
  db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('trust proxy (CP5-02)', () => {
  it('behind one trusted proxy, the per-IP login limit and the recorded IP use the client address from X-Forwarded-For', async () => {
    const app = await boot(1);
    try {
      const http = () => request(app.getHttpServer());
      // 55 different staff devices behind Caddy, one failed login each: nobody is rate limited
      const statuses: number[] = [];
      for (let i = 0; i < 55; i++) {
        statuses.push((await http().post('/api/v1/auth/login').set('X-Forwarded-For', `10.20.${Math.floor(i / 200)}.${(i % 200) + 1}`)
          .send({ username: `ghost.device${i}`, password: 'wrong guess' })).status);
      }
      expect(statuses.filter((s) => s === 429)).toHaveLength(0);
      expect(await attemptIps('ghost.device7')).toEqual(['10.20.0.8']);

      // a client that sends its own X-Forwarded-For cannot hide behind it: Caddy's appended entry is the one used
      await http().post('/api/v1/auth/login').set('X-Forwarded-For', '203.0.113.9, 10.20.5.5').send({ username: 'ghost.spoof', password: 'x' });
      expect(await attemptIps('ghost.spoof')).toEqual(['10.20.5.5']);
    } finally {
      await app.close();
    }
  });

  it('with no trusted proxy (the default) X-Forwarded-For is ignored', async () => {
    const app = await boot(false);
    try {
      await request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Forwarded-For', '10.20.9.9').send({ username: 'ghost.direct', password: 'x' });
      const ips = await attemptIps('ghost.direct');
      expect(ips).toHaveLength(1);
      expect(ips[0]).not.toBe('10.20.9.9');
      expect(ips[0]).toMatch(/^(127\.0\.0\.1|::1)$/);
    } finally {
      await app.close();
    }
  });
});
