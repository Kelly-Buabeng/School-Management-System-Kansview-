// Owner: Agent C. Shared setup for finance integration tests (fake Ghanaian data only).
import { randomUUID } from 'node:crypto';
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

export const USERS = {
  ADMIN: '00000000-0000-7000-8000-0000000000a1',
  ADMIN2: '00000000-0000-7000-8000-0000000000a2',
  BURSAR: '00000000-0000-7000-8000-0000000000b1',
  HEADTEACHER: '00000000-0000-7000-8000-0000000000c1',
  REGISTRAR: '00000000-0000-7000-8000-0000000000d1',
  TEACHER: '00000000-0000-7000-8000-0000000000e1',
} as const;

export const RANDOM_ID = '01900000-0000-7000-8000-00000000dead';

export interface Ctx {
  db: TestDatabase;
  app: INestApplication;
  k: Kysely<DB>;
  as(role: keyof typeof USERS, extraRoles?: Role[]): AuthUser;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function setupC(): Promise<Ctx> {
  const db = await createTestDatabase('c_fin');
  const pool = new pg.Pool({ connectionString: db.url, max: 4 });
  // db.drop() uses DROP DATABASE ... WITH (FORCE); the server may terminate a client that is still closing (57P01).
  pool.on('error', () => {});
  const k = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  for (const [name, id] of Object.entries(USERS)) {
    const role = name.replace(/\d$/, '');
    await sql`INSERT INTO app.users (id, username, full_name, password_hash, roles, must_change_password)
              VALUES (${id}::uuid, ${`c-${name.toLowerCase()}`}, ${`Test ${name}`}, 'x', ARRAY[${role}]::text[], false)`.execute(k);
  }
  const { app, currentUser } = await createTestApp(db.url, null);
  const as = (name: keyof typeof USERS, extraRoles: Role[] = []) => {
    const role = name.replace(/\d$/, '') as Role;
    currentUser.value = fakeUser([role, ...extraRoles], { id: USERS[name], fullName: `Test ${name}` });
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

export interface School {
  yearId: string;
  termIds: string[];
  levels: { P1: string; P2: string };
  classes: { P1A: string; P2A: string };
  feeItems: { tuition: string; pta: string; feeding: string; bus: string };
}

/** Year 2026/2027, three terms (term 1 contains today, 2026-11), P1 A and P2 A, four fee items. */
export async function seedSchool(k: Kysely<DB>): Promise<School> {
  const y = await k.insertInto('academic_years').values({ name: '2026/2027', start_date: '2026-09-01', end_date: '2027-07-31', status: 'current' }).returning('id').executeTakeFirstOrThrow();
  const terms = await k.insertInto('terms').values([
    { academic_year_id: y.id, number: 1, name: 'Term 1', start_date: '2026-09-07', end_date: '2026-12-18', status: 'current' },
    { academic_year_id: y.id, number: 2, name: 'Term 2', start_date: '2027-01-11', end_date: '2027-04-09' },
    { academic_year_id: y.id, number: 3, name: 'Term 3', start_date: '2027-04-26', end_date: '2027-07-23' },
  ]).returning(['id', 'number']).execute();
  const lv = await k.selectFrom('levels').select(['id', 'code']).execute();
  const P1 = lv.find((l) => l.code === 'P1')!.id;
  const P2 = lv.find((l) => l.code === 'P2')!.id;
  const P1A = (await k.insertInto('classes').values({ academic_year_id: y.id, level_id: P1, stream: 'A', display_name: 'Primary 1 A', capacity: 40 }).returning('id').executeTakeFirstOrThrow()).id;
  const P2A = (await k.insertInto('classes').values({ academic_year_id: y.id, level_id: P2, stream: 'A', display_name: 'Primary 2 A', capacity: 40 }).returning('id').executeTakeFirstOrThrow()).id;
  const fi = async (code: string, name: string, category: 'tuition' | 'pta' | 'feeding' | 'transport', prio: number, optional = false) =>
    (await k.insertInto('fee_items').values({ code, name, category, allocation_priority: prio, is_optional: optional }).returning('id').executeTakeFirstOrThrow()).id;
  return {
    yearId: y.id,
    termIds: terms.sort((a, b) => a.number - b.number).map((t) => t.id),
    levels: { P1, P2 },
    classes: { P1A, P2A },
    feeItems: { tuition: await fi('TUITION', 'Tuition', 'tuition', 1), pta: await fi('PTA', 'PTA levy', 'pta', 2), feeding: await fi('FEEDING', 'Feeding', 'feeding', 5), bus: await fi('BUS', 'School bus', 'transport', 6, true) },
  };
}

const FIRST = ['Kwame', 'Ama', 'Kofi', 'Akosua', 'Yaw', 'Efua', 'Selorm', 'Naa', 'Abdul', 'Esi'];
const LAST = ['Mensah', 'Owusu', 'Agbeko', 'Quaye', 'Osei', 'Boateng', 'Addo', 'Danso', 'Iddrisu', 'Tetteh'];
let seq = 0;

/** Active student enrolled in a class (student code from the real generator). */
export async function addStudent(k: Kysely<DB>, classId: string, yearId: string, opts: { dob?: string } = {}): Promise<string> {
  const code = (await sql<{ c: string }>`select app.next_student_code(2026) as c`.execute(k)).rows[0]!.c;
  const n = seq++;
  const s = await k.insertInto('students').values({
    student_code: code, admission_year: 2026, admission_seq: Number(code.slice(7, 12)), first_name: FIRST[n % 10]!, last_name: LAST[(n * 3) % 10]!,
    date_of_birth: opts.dob ?? `201${n % 9}-0${(n % 8) + 1}-1${n % 9}`, gender: n % 2 ? 'female' : 'male', status: 'active',
  }).returning('id').executeTakeFirstOrThrow();
  await k.insertInto('enrolments').values({ student_id: s.id, class_id: classId, academic_year_id: yearId, start_date: '2026-09-07', status: 'active' }).execute();
  return s.id;
}

export async function addGuardian(k: Kysely<DB>, studentIds: string[], feePayer = true): Promise<string> {
  const n = seq++;
  const g = await k.insertInto('guardians').values({ first_name: FIRST[n % 10]!, last_name: LAST[n % 10]!, phone_primary: `+23324000${String(1000 + n).slice(-4)}` }).returning('id').executeTakeFirstOrThrow();
  for (const [i, sid] of studentIds.entries()) {
    await k.insertInto('student_guardians').values({ student_id: sid, guardian_id: g.id, relationship: 'mother', is_primary: i >= 0, is_fee_payer: feePayer }).execute();
  }
  return g.id;
}

export const key = () => `test-${randomUUID()}`;

export async function auditEvents(ctx: Ctx): Promise<Array<{ action: string; entityType: string; entityId?: string | null; reason?: string | null }>> {
  const svc = ctx.app.get(AUDIT_SERVICE, { strict: false }) as { events?: Array<{ action: string; entityType: string; entityId?: string | null; reason?: string | null }> };
  return svc.events ?? [];
}

/** Creates and activates a structure for a level and term (as BURSAR then ADMIN). */
export async function activeStructure(ctx: Ctx, termId: string, levelId: string, lines: Array<{ feeItemId: string; amountPesewas: number; isOptional?: boolean }>): Promise<string> {
  ctx.as('BURSAR');
  const r = await ctx.http().post('/api/v1/fee-structures').send({ termId, levelId, name: 'Fees', lines }).expect(201);
  ctx.as('ADMIN');
  await ctx.http().post(`/api/v1/fee-structures/${r.body.id}/activate`).expect(200);
  return r.body.id as string;
}
