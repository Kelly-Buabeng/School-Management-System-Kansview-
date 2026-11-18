/**
 * Agent D: object-level scope (TEACHER = own classes today) and field rules, exercised through Agent B's real
 * student / guardian / emergency endpoints with the real DbScopeService and RoleFieldPolicy bound.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admissionBody, seedSchool, setupB, type Ctx, type School } from '../b/helpers';

let ctx: Ctx;
let school: School;
let mine: string; // student in P1A (teacher's class)
let other: string; // student in P1B
let teacherStaff: string;
let guardianId: string;

beforeAll(async () => {
  ctx = await setupB();
  school = await seedSchool(ctx.k);
  ctx.as('REGISTRAR');
  const a = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P1A, { firstName: 'Esi', lastName: 'Mensah', homeAddress: 'Hse 4, Adenta' })).expect(201);
  mine = a.body.id;
  const b = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P1B, { firstName: 'Kojo', lastName: 'Boateng', dateOfBirth: '2019-05-01' })).expect(201);
  other = b.body.id;
  await ctx.http().put(`/api/v1/students/${mine}/medical`).send({ allergies: 'Peanuts (severe)', alertSummary: 'Severe peanut allergy', bloodGroup: 'O+' }).expect(200);
  const g = await ctx.http().get(`/api/v1/students/${mine}/guardians`).expect(200);
  guardianId = (g.body.data ?? g.body)[0].guardianId ?? (g.body.data ?? g.body)[0].id;

  const st = await ctx.k.insertInto('staff').values({ staff_code: 'STF-D01', first_name: 'Ama', last_name: 'Teacher', staff_type: 'teaching' }).returning('id').executeTakeFirstOrThrow();
  teacherStaff = st.id;
  await ctx.k.insertInto('staff_class_assignments').values({ staff_id: teacherStaff, class_id: school.classes.P1A, role: 'class_teacher', start_date: '2026-09-01' }).execute();
});
afterAll(async () => {
  await ctx?.close();
});

const asTeacher = () => ctx.as('TEACHER', { staffId: teacherStaff });

describe('TEACHER scope (own classes only, 404 outside)', () => {
  it('sees a student in an assigned class', async () => {
    asTeacher();
    await ctx.http().get(`/api/v1/students/${mine}`).expect(200);
    await ctx.http().get(`/api/v1/students/${mine}/emergency-view`).expect(200);
  });

  it.each(['', '/emergency-view', '/guardians', '/emergency-contacts', '/pickups'])('gets 404 for another class: /students/{id}%s', async (path) => {
    asTeacher();
    const r = await ctx.http().get(`/api/v1/students/${other}${path}`);
    expect(r.status).toBe(404);
  });

  it('a TEACHER with no staff record or an ended assignment sees nothing', async () => {
    ctx.as('TEACHER', { staffId: null });
    await ctx.http().get(`/api/v1/students/${mine}`).expect(404);
    const st = await ctx.k.insertInto('staff').values({ staff_code: 'STF-D02', first_name: 'Old', last_name: 'Teacher', staff_type: 'teaching' }).returning('id').executeTakeFirstOrThrow();
    await ctx.k.insertInto('staff_class_assignments').values({ staff_id: st.id, class_id: school.classes.P1A, role: 'assistant', start_date: '2026-09-01', end_date: '2026-10-01' }).execute();
    ctx.as('TEACHER', { staffId: st.id });
    await ctx.http().get(`/api/v1/students/${mine}`).expect(404);
  });

  it('student list only contains own-class students', async () => {
    asTeacher();
    const r = await ctx.http().get('/api/v1/students').expect(200);
    const ids = r.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(other);
  });

  it('other roles are not class-scoped', async () => {
    for (const role of ['ADMIN', 'HEADTEACHER', 'REGISTRAR', 'BURSAR'] as const) {
      ctx.as(role);
      await ctx.http().get(`/api/v1/students/${other}`).expect(200);
    }
  });
});

describe('field rules on real responses', () => {
  it('TEACHER and BURSAR do not get the home address; REGISTRAR does', async () => {
    asTeacher();
    expect((await ctx.http().get(`/api/v1/students/${mine}`).expect(200)).body.homeAddress).toBeUndefined();
    ctx.as('BURSAR');
    expect((await ctx.http().get(`/api/v1/students/${mine}`).expect(200)).body.homeAddress).toBeUndefined();
    ctx.as('REGISTRAR');
    expect((await ctx.http().get(`/api/v1/students/${mine}`).expect(200)).body.homeAddress).toBe('Hse 4, Adenta');
  });

  it('medical detail: BURSAR and TEACHER refused, Emergency View shows the alert summary, not the full record', async () => {
    ctx.as('BURSAR');
    await ctx.http().get(`/api/v1/students/${mine}/medical`).expect(403);
    asTeacher();
    await ctx.http().get(`/api/v1/students/${mine}/medical`).expect(403);
    const ev = await ctx.http().get(`/api/v1/students/${mine}/emergency-view`).expect(200);
    expect(JSON.stringify(ev.body)).toContain('Severe peanut allergy');
    for (const k of ['chronicConditions', 'medicationNotes', 'specialNeeds', 'doctorName']) expect(JSON.stringify(ev.body)).not.toContain(`"${k}"`);
  });

  it('guardian: no full Ghana Card anywhere, BURSAR gets no address', async () => {
    ctx.as('ADMIN');
    const g = await ctx.http().get(`/api/v1/guardians/${guardianId}`).expect(200);
    expect(g.body.ghanaCard).toBeUndefined();
    ctx.as('BURSAR');
    const gb = await ctx.http().get(`/api/v1/guardians/${guardianId}`).expect(200);
    expect(gb.body.homeAddress).toBeUndefined();
    expect(gb.body.workAddress).toBeUndefined();
  });

  it('Emergency View opening is audited with the student id', async () => {
    asTeacher();
    await ctx.http().get(`/api/v1/students/${mine}/emergency-view`).expect(200);
    const rows = await ctx.k.selectFrom('audit.events').select(['action', 'student_id']).where('action', '=', 'emergency_view').execute();
    expect(rows.some((r) => r.student_id === mine)).toBe(true);
  });
});
