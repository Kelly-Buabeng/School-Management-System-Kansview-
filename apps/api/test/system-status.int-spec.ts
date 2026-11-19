// Owner: Agent H. GET /api/v1/system/status (system:read, ADMIN only) and worker housekeeping.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { createTestApp, fakeUser } from './support/test-app';
import type { AuthUser } from '../src/security/auth-user';
import type { Role } from '../src/security/permissions';
import { MaintenanceService } from '../src/modules/system/maintenance.service';

describe('system status', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let currentUser: { value: AuthUser | null };
  const statusDir = mkdtempSync(join(tmpdir(), 'h-backup-status-'));

  beforeAll(async () => {
    process.env.SMS_BACKUP_STATUS_DIR = statusDir;
    process.env.SMS_APP_VERSION = '1.2.3-test';
    writeFileSync(
      join(statusDir, 'base-backup.json'),
      JSON.stringify({ component: 'base-backup', result: 'success', updatedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastFailureAt: null, message: 'Backup completed', backupId: '20261118T013000Z' }),
    );
    writeFileSync(join(statusDir, 'offsite.json'), JSON.stringify({ component: 'offsite', result: 'success', lastSuccessAt: new Date().toISOString(), message: 'Off-site copy up to date' }));
    db = await createTestDatabase('sms_t_h');
    ({ app, currentUser } = await createTestApp(db.url, fakeUser(['ADMIN'])));
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
    delete process.env.SMS_BACKUP_STATUS_DIR;
  });

  it('ADMIN sees backup, disk, queue and version', async () => {
    currentUser.value = fakeUser(['ADMIN']);
    const res = await request(app.getHttpServer()).get('/api/v1/system/status').expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({
      version: '1.2.3-test',
      smsProvider: 'mock',
      backup: { lastBackupResult: 'success', backupOverdue: false },
    });
    expect(res.body.backup.components.map((c: { component: string }) => c.component).sort()).toEqual(['base-backup', 'offsite']);
    expect(res.body.disks.length).toBeGreaterThan(0);
    expect(typeof res.body.queue.available).toBe('boolean');
    // The only problem allowed here is the test machine's own disk being nearly full.
    const otherProblems = (res.body.problems as string[]).filter((p) => !p.startsWith('Disk space is low'));
    expect(otherProblems).toEqual([]);
    const anyDiskLow = (res.body.disks as Array<{ low: boolean }>).some((d) => d.low);
    expect(res.body.overall).toBe(anyDiskLow ? 'problem' : res.body.queue.available ? 'ok' : 'warning');
  });

  it.each<Role>(['BURSAR', 'HEADTEACHER', 'REGISTRAR', 'TEACHER'])('%s is denied (403)', async (role) => {
    currentUser.value = fakeUser([role]);
    const res = await request(app.getHttpServer()).get('/api/v1/system/status').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('signed-out request is refused (401)', async () => {
    currentUser.value = null;
    await request(app.getHttpServer()).get('/api/v1/system/status').expect(401);
  });

  it('housekeeping deletes only old sessions and reset tokens', async () => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      const u = await c.query<{ id: string }>(`SELECT id FROM app.users LIMIT 1`);
      let userId = u.rows[0]?.id;
      if (!userId) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO app.users (username, full_name, password_hash, roles) VALUES ('h-house', 'House Keeping', 'x', ARRAY['ADMIN']) RETURNING id`,
        );
        userId = ins.rows[0]!.id;
      }
      await c.query(
        `INSERT INTO app.user_sessions (id, user_id, created_at, expires_at, idle_expires_at) VALUES
           ('h-old', $1, now() - interval '90 days', now() - interval '60 days', now() - interval '60 days'),
           ('h-new', $1, now(), now() + interval '8 hours', now() + interval '30 minutes')`,
        [userId],
      );
      await c.query(
        `INSERT INTO app.password_reset_tokens (user_id, token_hash, created_at, expires_at, used_at) VALUES
           ($1, 'h-old-token', now() - interval '30 days', now() - interval '29 days', NULL),
           ($1, 'h-new-token', now(), now() + interval '1 hour', NULL)`,
        [userId],
      );
      const result = await app.get(MaintenanceService).runOnce();
      expect(result.sessionsDeleted).toBe(1);
      expect(result.resetTokensDeleted).toBe(1);
      const left = await c.query(`SELECT id FROM app.user_sessions WHERE id LIKE 'h-%' ORDER BY id`);
      expect(left.rows.map((r) => r.id)).toEqual(['h-new']);
      const tokens = await c.query(`SELECT token_hash FROM app.password_reset_tokens WHERE token_hash LIKE 'h-%'`);
      expect(tokens.rows.map((r) => r.token_hash)).toEqual(['h-new-token']);
    } finally {
      await c.end();
    }
  });
});
