import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInAccra } from '@sms/shared';
import { seedSchool, setupB, type Ctx, type School } from './helpers';

/** Bulk seed: 1,000 active students across the current year's classes, each with a guardian (fake data). */
async function seedThousand(ctx: Ctx, school: School) {
  const classIds = [school.classes.KG1, school.classes.P1A, school.classes.P1B, school.classes.P2A, school.classes.JHS3];
  const first = ['Kwame', 'Ama', 'Kofi', 'Akua', 'Yaw', 'Abena', 'Kwesi', 'Efua', 'Kojo', 'Adwoa', 'Kwabena', 'Afia', 'Kwaku', 'Yaa', 'Fiifi', 'Esi'];
  const last = ['Mensah', 'Asante', 'Owusu', 'Boateng', 'Agyei', 'Osei', 'Appiah', 'Darko', 'Addo', 'Quaye', 'Tetteh', 'Ofori', 'Sarpong', 'Amoah', 'Nkrumah', 'Badu'];
  await sql`
    WITH n AS (SELECT g AS i, app.next_student_code(2026) AS code FROM generate_series(1, 1000) g),
    s AS (
      INSERT INTO app.students (student_code, admission_year, admission_seq, first_name, last_name, date_of_birth, gender, admission_date, status)
      SELECT code, 2026, substr(code, 8, 5)::int, (${first}::text[])[1 + i % 16], (${last}::text[])[1 + (i / 16) % 16] || CASE WHEN i % 3 = 0 THEN '' ELSE '-' || i END,
             (date '2014-01-01' + (i * 7 % 3650)), CASE WHEN i % 2 = 0 THEN 'male'::app.gender ELSE 'female'::app.gender END, date '2026-09-07', 'active'
        FROM n RETURNING id, admission_seq),
    e AS (
      INSERT INTO app.enrolments (student_id, class_id, academic_year_id, roll_number, start_date, status)
      SELECT s.id, (${classIds}::uuid[])[1 + s.admission_seq % 5], ${school.yearId}::uuid, 1 + s.admission_seq / 5, date '2026-09-07', 'active' FROM s RETURNING student_id),
    g AS (
      INSERT INTO app.guardians (first_name, last_name, phone_primary)
      SELECT 'Parent', 'Of' || s.admission_seq, '+2332400' || lpad(s.admission_seq::text, 5, '0') FROM s RETURNING id, last_name)
    INSERT INTO app.student_guardians (student_id, guardian_id, relationship, is_primary, is_fee_payer)
    SELECT s.id, g.id, 'mother', true, true FROM s JOIN g ON g.last_name = 'Of' || s.admission_seq`.execute(ctx.k);
  await sql`ANALYZE`.execute(ctx.k);
}

describe('search and dashboard', () => {
  let ctx: Ctx;
  let school: School;
  beforeAll(async () => {
    ctx = await setupB();
    school = await seedSchool(ctx.k);
    await seedThousand(ctx, school);
    await ctx.k.insertInto('staff').values({ staff_code: 'STF-0101', first_name: 'Comfort', last_name: 'Adjei', staff_type: 'teaching', job_title: 'Teacher' }).execute();
  }, 120_000);
  afterAll(async () => { await ctx?.close(); });

  it('finds students by name (fuzzy), code prefix and class; guardians by phone; staff by name', async () => {
    ctx.as('REGISTRAR');
    const byName = await ctx.http().get('/api/v1/search').query({ q: 'kwame mensa' }).expect(200);
    expect(byName.body.students.length).toBeGreaterThan(0);
    expect(byName.body.students[0].fullName.toLowerCase()).toContain('kwame');
    const code = (await ctx.k.selectFrom('students').select('student_code').orderBy('student_code').limit(1).executeTakeFirstOrThrow()).student_code;
    const byCode = await ctx.http().get('/api/v1/search').query({ q: code.toLowerCase() }).expect(200);
    expect(byCode.body.students[0].studentCode).toBe(code);
    const byClass = await ctx.http().get('/api/v1/search').query({ q: 'P1 A', limit: 20 }).expect(200);
    expect(byClass.body.students.every((s: { className: string }) => s.className === 'Primary 1 A')).toBe(true);
    const byPhone = await ctx.http().get('/api/v1/search').query({ q: '024 0000 042' }).expect(200);
    expect(byPhone.body.guardians[0]).toMatchObject({ phone: '+233240000042', childrenCount: 1 });
    const staff = await ctx.http().get('/api/v1/search').query({ q: 'comfort' }).expect(200);
    expect(staff.body.staff[0]).toMatchObject({ fullName: 'Comfort Adjei' });
    expect(staff.body.receipts).toEqual([]);
    await ctx.http().get('/api/v1/search').query({ q: 'a' }).expect(400);
    await ctx.http().get('/api/v1/search').query({ q: 'ama', limit: 50 }).expect(400);
  });

  it('only searches groups the role may read', async () => {
    ctx.as('TEACHER');
    const r = await ctx.http().get('/api/v1/search').query({ q: 'comfort' }).expect(200);
    expect(r.body.staff).toEqual([]);
    ctx.as('BURSAR');
    const b = await ctx.http().get('/api/v1/search').query({ q: 'RCP-0000' }).expect(200);
    expect(b.body.receipts).toEqual([]);
  });

  it('p95 under 300 ms on 1,000 students', async () => {
    ctx.as('ADMIN');
    const queries = ['kwame', 'asante', 'efua osei', 'KSV-26-00', '0240000123', 'P2 A', 'yaa badu', 'kojo', 'mensah', 'adwoa appiah'];
    for (const q of queries) await ctx.http().get('/api/v1/search').query({ q }).expect(200); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await ctx.http().get('/api/v1/search').query({ q: queries[i % queries.length] }).expect(200);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(300);
  });

  it('dashboard widgets are filtered by role', async () => {
    const today = todayInAccra();
    const bday = `2017-${today.slice(5)}`;
    const sid = (await ctx.k.selectFrom('students').select('id').limit(1).executeTakeFirstOrThrow()).id;
    await ctx.k.updateTable('students').set({ date_of_birth: bday }).where('id', '=', sid).execute();
    ctx.as('ADMIN');
    const a = await ctx.http().get('/api/v1/dashboard').expect(200);
    expect(a.body.widgets.enrolmentByClass.totalStudents).toBe(1000);
    expect(a.body.widgets.upcomingBirthdays.some((b: { studentId: string; inDays: number }) => b.studentId === sid && b.inDays === 0)).toBe(true);
    expect(a.body.widgets.finance).toMatchObject({ billedPesewas: 0 });
    expect(a.body.widgets.attendanceTrend).toEqual([]);
    ctx.as('BURSAR');
    const b = await ctx.http().get('/api/v1/dashboard').expect(200);
    expect(Object.keys(b.body.widgets)).toEqual(['finance']);
    ctx.as('REGISTRAR');
    const r = await ctx.http().get('/api/v1/dashboard').expect(200);
    expect(Object.keys(r.body.widgets).sort()).toEqual(['enrolmentByClass', 'upcomingBirthdays']);
    ctx.as('TEACHER');
    const t = await ctx.http().get('/api/v1/dashboard').expect(200);
    expect(t.body.widgets.finance).toBeUndefined();
    expect(t.body.widgets.enrolmentByClass).toBeUndefined();
  });
});
