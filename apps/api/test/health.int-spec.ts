import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { createTestApp } from './support/test-app';

describe('scaffold: app boots against a migrated test database', () => {
  let db: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = await createTestApp(db.url));
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('health endpoints are public', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200, { status: 'ok' });
  });

  it('unknown routes return problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(res.body.requestId).toBeTruthy();
  });
});
