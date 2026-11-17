// Owner: Agent B. Shared setup for Agent B integration tests.
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import request from 'supertest';
import type { DB } from '@sms/db-types';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createTestApp, fakeUser } from '../support/test-app';
import type { AuthUser } from '../../src/security/auth-user';
import type { Role } from '../../src/security/permissions';
import { AUDIT_SERVICE } from '../../src/security/audit.service';

export const USER_IDS: Record<Role, string> = {
  ADMIN: '00000000-0000-7000-8000-000000000001',
  BURSAR: '00000000-0000-7000-8000-000000000002',
  HEADTEACHER: '00000000-0000-7000-8000-000000000003',
  REGISTRAR: '00000000-0000-7000-8000-000000000004',
  TEACHER: '00000000-0000-7000-8000-000000000005',
};

export interface Ctx {
  db: TestDatabase;
  app: INestApplication;
  k: Kysely<DB>;
  as(roles: Role | Role[], overrides?: Partial<AuthUser>): AuthUser;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/** Fresh migrated database + app. Seeds one users row per role so FK columns (recorded_by etc.) accept the fake users. */
export async function setupB(): Promise<Ctx> {
  const db = await createTestDatabase('b_t');
  const k = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: db.url, max: 4 }) }) });
  for (const [role, id] of Object.entries(USER_IDS)) {
    await sql`INSERT INTO app.users (id, username, full_name, password_hash, roles, must_change_password)
              VALUES (${id}::uuid, ${`test-${role.toLowerCase()}`}, ${`Test ${role}`}, 'x', ARRAY[${role}]::text[], false)
              ON CONFLICT DO NOTHING`.execute(k);
  }
  const { app, currentUser } = await createTestApp(db.url, fakeUser(['ADMIN']));
  const as = (roles: Role | Role[], overrides: Partial<AuthUser> = {}) => {
    const list = Array.isArray(roles) ? roles : [roles];
    currentUser.value = fakeUser(list, { id: USER_IDS[list[0]!], ...overrides });
    return currentUser.value;
  };
  return {
    db, app, k, as,
    http: () => request(app.getHttpServer()),
    async close() {
      await app?.close();
      await k.destroy();
      await db.drop();
    },
  };
}

export interface AuditRow { action: string; entityType: string; entityId?: string | null; studentId?: string | null; reason?: string | null }

/** Audit events written so far: from the stub's in-memory list, or from audit.events once Agent D's writer is bound. */
export async function auditEvents(ctx: Ctx): Promise<AuditRow[]> {
  const svc = ctx.app.get(AUDIT_SERVICE, { strict: false }) as { events?: AuditRow[] };
  if (Array.isArray(svc.events)) return svc.events;
  const r = await sql<{ action: string; entity_type: string; entity_id: string | null; student_id: string | null; reason: string | null }>`
    SELECT action, entity_type, entity_id::text, student_id::text, reason FROM audit.events ORDER BY id`.execute(ctx.k);
  return r.rows.map((x) => ({ action: x.action, entityType: x.entity_type, entityId: x.entity_id, studentId: x.student_id, reason: x.reason }));
}

export const RANDOM_ID = '01900000-0000-7000-8000-00000000dead';

export interface School {
  yearId: string;
  nextYearId: string;
  termIds: string[];
  levels: Record<string, string>;
  classes: Record<string, string>;
}

/**
 * Seeds a small school directly in SQL: current year 2026/2027 (3 terms, term 1 current) and planned 2027/2028,
 * seeded levels (KG1, P1 → P2, JHS3 final), classes for both years (P1 A/B, P2 A, JHS3, KG1).
 */
export async function seedSchool(k: Kysely<DB>): Promise<School> {
  const y1 = await k.insertInto('academic_years').values({ name: '2026/2027', start_date: '2026-09-01', end_date: '2027-07-31', status: 'current' }).returning('id').executeTakeFirstOrThrow();
  const y2 = await k.insertInto('academic_years').values({ name: '2027/2028', start_date: '2027-09-01', end_date: '2028-07-31' }).returning('id').executeTakeFirstOrThrow();
  const terms = await k.insertInto('terms').values([
    { academic_year_id: y1.id, number: 1, name: 'Term 1', start_date: '2026-09-07', end_date: '2026-12-18', status: 'current' },
    { academic_year_id: y1.id, number: 2, name: 'Term 2', start_date: '2027-01-11', end_date: '2027-04-09' },
    { academic_year_id: y1.id, number: 3, name: 'Term 3', start_date: '2027-04-26', end_date: '2027-07-23' },
    { academic_year_id: y2.id, number: 1, name: 'Term 1', start_date: '2027-09-06', end_date: '2027-12-17' },
    { academic_year_id: y2.id, number: 2, name: 'Term 2', start_date: '2028-01-10', end_date: '2028-04-07' },
    { academic_year_id: y2.id, number: 3, name: 'Term 3', start_date: '2028-04-24', end_date: '2028-07-21' },
  ]).returning(['id', 'academic_year_id', 'number']).execute();
  // Levels come from the reference data migration (Creche → JHS3, chained by next_level_id).
  const lv = await k.selectFrom('levels').select(['id', 'code']).execute();
  const byCode = (c: string) => lv.find((l) => l.code === c)!;
  const [kg1, p1, p2, jhs3] = [byCode('KG1'), byCode('P1'), byCode('P2'), byCode('JHS3')];
  const mk = async (yearId: string, levelId: string, stream: string | null, name: string, capacity: number | null = 40) =>
    (await k.insertInto('classes').values({ academic_year_id: yearId, level_id: levelId, stream, display_name: name, capacity }).returning('id').executeTakeFirstOrThrow()).id;
  const classes = {
    KG1: await mk(y1.id, kg1.id, null, 'KG 1'),
    P1A: await mk(y1.id, p1.id, 'A', 'Primary 1 A'),
    P1B: await mk(y1.id, p1.id, 'B', 'Primary 1 B'),
    P2A: await mk(y1.id, p2.id, 'A', 'Primary 2 A'),
    JHS3: await mk(y1.id, jhs3.id, null, 'JHS 3'),
    NEXT_P1: await mk(y2.id, p1.id, null, 'Primary 1'),
    NEXT_P2A: await mk(y2.id, p2.id, 'A', 'Primary 2 A'),
    NEXT_P2B: await mk(y2.id, p2.id, 'B', 'Primary 2 B'),
  };
  return {
    yearId: y1.id, nextYearId: y2.id,
    termIds: terms.filter((t) => t.academic_year_id === y1.id).sort((a, b) => a.number - b.number).map((t) => t.id),
    levels: { KG1: kg1.id, P1: p1.id, P2: p2.id, JHS3: jhs3.id }, classes,
  };
}

let phoneSeq = 0;
/** Unique fake Ghana test phone number (+23320000xxxx style, never a real subscriber). */
export function testPhone(): string {
  phoneSeq += 1;
  return `+2332000${String(10000 + phoneSeq).slice(-5)}`.slice(0, 13);
}

/** A valid admission body for the API. */
export function admissionBody(classId: string, overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Kwame', lastName: 'Asante', dateOfBirth: '2019-03-14', gender: 'male', admissionDate: '2026-09-07', classId,
    guardians: [{ newGuardian: { firstName: 'Akua', lastName: 'Asante', phonePrimary: testPhone() }, relationship: 'mother', isPrimary: true, isFeePayer: true, canPickUp: true }],
    ...overrides,
  };
}
