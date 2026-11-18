import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { admissionBody, RANDOM_ID, seedSchool, setupB, type Ctx, type School } from '../b/helpers';

let ctx: Ctx;
let school: School;
let studentId: string;
let studentCode: string;

beforeAll(async () => {
  ctx = await setupB();
  school = await seedSchool(ctx.k);
  ctx.as('REGISTRAR');
  const r = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P1A, { firstName: 'Adwoa', lastName: 'Sarpong', homeAddress: 'Hse 9, Tema Comm. 5' })).expect(201);
  studentId = r.body.id;
  studentCode = r.body.studentCode;
  await ctx.http().put(`/api/v1/students/${studentId}/medical`).send({ allergies: 'Penicillin', alertSummary: 'Penicillin allergy' }).expect(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('data subject requests', () => {
  let dsrId: string;

  it('REGISTRAR logs a request; due date is received + 21 days', async () => {
    ctx.as('REGISTRAR');
    const r = await ctx.http().post('/api/v1/data-subject-requests').send({ requesterName: 'Akua Sarpong', relationship: 'mother', studentId, type: 'access', receivedAt: '2026-11-02T09:00:00Z' }).expect(201);
    dsrId = r.body.id;
    expect(r.body.dueAt).toBe('2026-11-23T09:00:00.000Z');
    expect(r.body.status).toBe('received');
    await ctx.http().get('/api/v1/data-subject-requests').expect(403);
    await ctx.http().patch(`/api/v1/data-subject-requests/${dsrId}`).send({ status: 'completed' }).expect(403);
  });

  it('ADMIN lists and updates; HEADTEACHER reads only; BURSAR/TEACHER denied', async () => {
    ctx.as('ADMIN');
    const l = await ctx.http().get('/api/v1/data-subject-requests').expect(200);
    expect(l.body.data.map((d: { id: string }) => d.id)).toContain(dsrId);
    const u = await ctx.http().patch(`/api/v1/data-subject-requests/${dsrId}`).send({ status: 'completed', outcome: 'Data pack handed to mother on 2026-11-10' }).expect(200);
    expect(u.body).toMatchObject({ status: 'completed', overdue: false });
    await ctx.http().patch(`/api/v1/data-subject-requests/${RANDOM_ID}`).send({ status: 'completed' }).expect(404);
    await ctx.http().post('/api/v1/data-subject-requests').send({ requesterName: 'X Y', type: 'access' }).expect(400);
    await ctx.http().post('/api/v1/data-subject-requests').send({ requesterName: 'X Y', type: 'access', studentId: RANDOM_ID }).expect(404);
    ctx.as('HEADTEACHER');
    await ctx.http().get('/api/v1/data-subject-requests').expect(200);
    await ctx.http().post(`/api/v1/students/${studentId}/subject-access-export`).expect(403);
    for (const role of ['BURSAR', 'TEACHER'] as const) {
      ctx.as(role);
      await ctx.http().get('/api/v1/data-subject-requests').expect(403);
      await ctx.http().post('/api/v1/data-subject-requests').send({ requesterName: 'A B', type: 'access', studentId }).expect(403);
    }
  });
});

describe('subject access export', () => {
  it('returns the full data pack (with decrypted medical detail) and is audited', async () => {
    ctx.as('ADMIN');
    const r = await ctx.http().post(`/api/v1/students/${studentId}/subject-access-export`).expect(202);
    expect(r.body.data.student).toMatchObject({ student_code: studentCode, first_name: 'Adwoa', home_address: 'Hse 9, Tema Comm. 5' });
    expect(r.body.data.medical.allergies).toBe('Penicillin');
    expect(r.body.data.guardians).toHaveLength(1);
    expect(r.body.data.enrolments.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain('ghana_card_enc');
    const ev = await ctx.k.selectFrom('audit.events').select(['action', 'student_id']).where('entity_type', '=', 'subject_access_export').execute();
    expect(ev).toEqual([{ action: 'export', student_id: studentId }]);
    await ctx.http().post(`/api/v1/students/${RANDOM_ID}/subject-access-export`).expect(404);
  });
});

describe('retention and anonymisation', () => {
  it('active students are never retention candidates and cannot be anonymised', async () => {
    ctx.as('ADMIN');
    const c = await ctx.http().get('/api/v1/retention/candidates').expect(200);
    expect(c.body.data.map((x: { studentId: string }) => x.studentId)).not.toContain(studentId);
    const r = await ctx.http().post(`/api/v1/students/${studentId}/anonymise`).send({ confirmStudentCode: studentCode, reason: 'Retention period ended' }).expect(422);
    expect(r.body.code).toBe('VALIDATION_FAILED');
  });

  it('a student who left long ago becomes a candidate; anonymise needs the typed code; keeps code and finance', async () => {
    await sql`UPDATE app.students SET status = 'withdrawn' WHERE id = ${studentId}`.execute(ctx.k);
    await sql`INSERT INTO app.student_status_history (student_id, from_status, to_status, effective_date, reason, source)
              VALUES (${studentId}, 'active', 'withdrawn', '2015-07-31', 'Left school', 'manual')`.execute(ctx.k);
    ctx.as('ADMIN');
    const c = await ctx.http().get('/api/v1/retention/candidates').expect(200);
    expect(c.body.data).toEqual([expect.objectContaining({ studentId, studentCode, leftOn: '2015-07-31' })]);

    ctx.as('HEADTEACHER');
    await ctx.http().post(`/api/v1/students/${studentId}/anonymise`).send({ confirmStudentCode: studentCode, reason: 'Retention period ended' }).expect(403);
    ctx.as('ADMIN');
    const wrong = await ctx.http().post(`/api/v1/students/${studentId}/anonymise`).send({ confirmStudentCode: 'KSV-00-00000-0', reason: 'Retention period ended' }).expect(422);
    expect(wrong.body.code).toBe('DPA_ANONYMISE_CONFIRMATION_REQUIRED');
    const ok = await ctx.http().post(`/api/v1/students/${studentId}/anonymise`).send({ confirmStudentCode: studentCode.toLowerCase(), reason: 'Retention period ended' }).expect(200);
    expect(ok.body).toMatchObject({ studentCode, guardiansAnonymised: 1 });

    const s = await ctx.k.selectFrom('students').selectAll().where('id', '=', studentId).executeTakeFirstOrThrow();
    expect(s).toMatchObject({ student_code: studentCode, first_name: 'Anonymised', last_name: 'Student', home_address: null });
    expect(String(s.date_of_birth)).toMatch(/-01-01$/);
    const m = await ctx.k.selectFrom('student_medical').selectAll().where('student_id', '=', studentId).executeTakeFirstOrThrow();
    expect(m.allergies_enc).toBeNull();
    expect(m.alert_summary).toBeNull();
    const ra = await ctx.k.selectFrom('retention_actions').select(['entity_type', 'action']).execute();
    expect(ra).toEqual(expect.arrayContaining([{ entity_type: 'student', action: 'anonymised' }, { entity_type: 'guardian', action: 'anonymised' }]));
    expect((await ctx.http().get('/api/v1/retention/candidates').expect(200)).body.data).toEqual([]);
    await ctx.http().post(`/api/v1/students/${studentId}/anonymise`).send({ confirmStudentCode: studentCode, reason: 'Again please' }).expect(409);
    const ev = await ctx.k.selectFrom('audit.events').select('reason').where('entity_type', '=', 'student').where('action', '=', 'update').where('student_id', '=', studentId).execute();
    expect(ev.some((e) => e.reason?.startsWith('anonymised'))).toBe(true);
  });
});
