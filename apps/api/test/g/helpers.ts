// Owner: Agent G. Shared setup for import integration tests.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import request from 'supertest';
import type { DB } from '@sms/db-types';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createTestApp, fakeUser } from '../support/test-app';
import type { AuthUser } from '../../src/security/auth-user';
import type { Role } from '../../src/security/permissions';
import { FIXTURE_CLASSES } from './fixtures';

export const USER_IDS: Record<Role, string> = {
  ADMIN: '00000000-0000-7000-8000-0000000000a1',
  BURSAR: '00000000-0000-7000-8000-0000000000a2',
  HEADTEACHER: '00000000-0000-7000-8000-0000000000a3',
  REGISTRAR: '00000000-0000-7000-8000-0000000000a4',
  TEACHER: '00000000-0000-7000-8000-0000000000a5',
};

export interface GCtx {
  db: TestDatabase;
  app: INestApplication;
  k: Kysely<DB>;
  termIds: string[];
  as(roles: Role | Role[]): AuthUser;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/** Fresh migrated database + app, one users row per role, current year 2026/2027 with the fixture classes. */
export async function setupG(opts: { capacity?: number } = {}): Promise<GCtx> {
  process.env.SMS_FILE_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'g-files-'));
  const db = await createTestDatabase('g_t');
  const pool = new pg.Pool({ connectionString: db.url, max: 4 });
  // db.drop() uses DROP DATABASE ... WITH (FORCE); the server may terminate a client that is still closing (57P01).
  pool.on('error', () => {});
  const k = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  for (const [role, id] of Object.entries(USER_IDS)) {
    await sql`INSERT INTO app.users (id, username, full_name, password_hash, roles, must_change_password)
              VALUES (${id}::uuid, ${`g-${role.toLowerCase()}`}, ${`Test ${role}`}, 'x', ARRAY[${role}]::text[], false)`.execute(k);
  }
  const year = await k.insertInto('academic_years').values({ name: '2026/2027', start_date: '2026-09-01', end_date: '2027-07-31', status: 'current' }).returning('id').executeTakeFirstOrThrow();
  const terms = await k.insertInto('terms').values([
    { academic_year_id: year.id, number: 1, name: 'Term 1', start_date: '2026-09-07', end_date: '2026-12-18', status: 'current' },
    { academic_year_id: year.id, number: 2, name: 'Term 2', start_date: '2027-01-11', end_date: '2027-04-09' },
  ]).returning('id').execute();
  const levels = await k.selectFrom('levels').select(['id', 'code']).execute();
  for (const label of FIXTURE_CLASSES) {
    const [code, stream] = label.split(' ');
    await k.insertInto('classes').values({ academic_year_id: year.id, level_id: levels.find((l) => l.code === code)!.id, stream: stream ?? null, display_name: label, capacity: opts.capacity ?? 80 }).execute();
  }
  const { app, currentUser } = await createTestApp(db.url, fakeUser(['ADMIN'], { id: USER_IDS.ADMIN }));
  const as = (roles: Role | Role[]) => {
    const list = Array.isArray(roles) ? roles : [roles];
    currentUser.value = fakeUser(list, { id: USER_IDS[list[0]!] });
    return currentUser.value;
  };
  return {
    db, app, k, as, termIds: terms.map((t) => t.id),
    http: () => request(app.getHttpServer()),
    async close() {
      await app?.close();
      await k.destroy();
      await db.drop();
    },
  };
}

let keySeq = 0;
export function idemKey(): string {
  keySeq += 1;
  return `g-test-key-${Date.now()}-${keySeq}`;
}

/** Upload → validate. Returns the job after the dry run. */
export async function uploadAndValidate(ctx: GCtx, type: string, file: Buffer, name: string): Promise<{ id: string; totals: Record<string, number>; status: string }> {
  const up = await ctx.http().post('/api/v1/imports').field('type', type).attach('file', file, name);
  if (up.status !== 201) throw new Error(`upload failed ${up.status} ${JSON.stringify(up.body)}`);
  const v = await ctx.http().post(`/api/v1/imports/${up.body.id}/validate`);
  if (v.status !== 202) throw new Error(`validate failed ${v.status} ${JSON.stringify(v.body)}`);
  return v.body;
}

export async function count(ctx: GCtx, table: 'students' | 'guardians' | 'student_guardians' | 'enrolments' | 'ledger_entries' | 'staff'): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`app.${table}`)}`.execute(ctx.k);
  return r.rows[0]!.n;
}
