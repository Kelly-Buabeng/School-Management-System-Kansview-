import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_SERVICE, type NotificationService } from '../../src/common/contracts';
import { admissionBody, auditEvents, RANDOM_ID, seedSchool, setupB, USER_IDS, type Ctx, type School } from './helpers';

describe('staff, attendance, academics, welfare', () => {
  let ctx: Ctx;
  let school: School;
  const s: string[] = [];
  beforeAll(async () => {
    ctx = await setupB();
    school = await seedSchool(ctx.k);
    ctx.as('REGISTRAR');
    for (const [i, n] of ['Abena', 'Kofi', 'Yaa'].entries()) {
      s.push((await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P1A, { firstName: n, lastName: 'Owusu', dateOfBirth: `2019-0${i + 1}-10` })).expect(201)).body.id);
    }
  });
  afterAll(async () => { await ctx?.close(); });

  let staffId = '';
  it('staff: create with code, write-only sensitive fields, audited reveal, assignments, If-Match', async () => {
    ctx.as('ADMIN');
    const r = await ctx.http().post('/api/v1/staff').send({ firstName: 'Comfort', lastName: 'Adjei', title: 'Mrs', staffType: 'teaching', phone: '0240000555', ghanaCardNumber: 'GHA-987654321-0', ssnitNo: 'C123456789' }).expect(201);
    staffId = r.body.id;
    expect(r.body).toMatchObject({ staffCode: 'STF-0001', phone: '+233240000555', hasGhanaCard: true, hasSsnit: true });
    expect(JSON.stringify(r.body)).not.toContain('987654321');
    const rev = await ctx.http().post(`/api/v1/staff/${staffId}/sensitive/reveal`).send({ reason: 'Payroll check' }).expect(200);
    expect(rev.body).toMatchObject({ ghanaCardNumber: 'GHA-987654321-0', ssnitNo: 'C123456789' });
    expect((await auditEvents(ctx)).some((e) => e.action === 'reveal_sensitive' && e.entityType === 'staff')).toBe(true);
    const a = await ctx.http().put(`/api/v1/staff/${staffId}/assignments`).send([{ classId: school.classes.P1A, role: 'class_teacher' }]).expect(200);
    expect(a.body[0]).toMatchObject({ classId: school.classes.P1A, role: 'class_teacher' });
    const cls = await ctx.http().get(`/api/v1/classes/${school.classes.P1A}`).expect(200);
    expect(cls.body.classTeacherStaffId).toBe(staffId);
    await ctx.http().put(`/api/v1/staff/${staffId}/emergency-contacts`).send([{ name: 'Kwabena Adjei', phone: '0200000777' }]).expect(200);
    await ctx.http().patch(`/api/v1/staff/${staffId}`).set('If-Match', '1').send({ jobTitle: 'P1 class teacher' }).expect(200);
    await ctx.http().patch(`/api/v1/staff/${staffId}`).set('If-Match', '1').send({ jobTitle: 'x' }).expect(412);
    ctx.as('REGISTRAR');
    await ctx.http().get('/api/v1/staff').expect(200);
    await ctx.http().post(`/api/v1/staff/${staffId}/sensitive/reveal`).send({ reason: 'curious' }).expect(403);
    await ctx.http().post('/api/v1/staff').send({ firstName: 'X', lastName: 'Y', staffType: 'teaching' }).expect(403);
    ctx.as('TEACHER');
    await ctx.http().get('/api/v1/staff').expect(403);
    ctx.as('ADMIN');
    await ctx.http().get(`/api/v1/staff/${RANDOM_ID}`).expect(404);
  });

  it('attendance: pre-filled register, save, absence SMS once per student per day', async () => {
    ctx.as('TEACHER');
    const date = '2026-11-16';
    const reg = await ctx.http().get(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date }).expect(200);
    expect(reg.body).toMatchObject({ taken: false });
    expect(reg.body.records.every((r: { status: string }) => r.status === 'present')).toBe(true);
    const notify = ctx.app.get<NotificationService>(NOTIFICATION_SERVICE, { strict: false });
    const calls: string[] = [];
    notify.enqueue = async (_t, recipients, _c, opts) => {
      calls.push(opts?.dedupeKey ?? '');
      const m = await ctx.k.insertInto('messages').values({ kind: 'absence_alert', recipient_count: recipients.length }).returning('id').executeTakeFirstOrThrow();
      return { messageId: m.id };
    };
    const body = { records: [{ studentId: s[0]!, status: 'absent' }, { studentId: s[1]!, status: 'late' }, { studentId: s[2]!, status: 'present' }] };
    const saved = await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date }).send(body).expect(200);
    expect(saved.body.taken).toBe(true);
    expect(saved.body.records.find((r: { studentId: string }) => r.studentId === s[0]).smsSent).toBe(true);
    await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date }).send(body).expect(200);
    expect(calls).toEqual([`absence:${s[0]}:${date}`]);
    await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date: '2099-01-01' }).send(body).expect(400);
    await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date }).send({ records: [{ studentId: RANDOM_ID, status: 'present' }] }).expect(400);
    const sum = await ctx.http().get('/api/v1/attendance/summary').query({ from: '2026-11-01', to: '2026-11-30', classId: school.classes.P1A }).expect(200);
    expect(sum.body.classes[0]).toMatchObject({ total: 3, present: 2, absent: 1, late: 1 });
    ctx.as('BURSAR');
    await ctx.http().get(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date }).expect(403);
    ctx.as('HEADTEACHER');
    await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/attendance`).query({ date }).send(body).expect(403);
    await ctx.http().get(`/api/v1/classes/${RANDOM_ID}/attendance`).query({ date }).expect(404);
  });

  it('academics: scores with weights and grades, lock, report cards with joint positions, remarks, publish', async () => {
    ctx.as('ADMIN');
    const subj = (await ctx.http().post('/api/v1/subjects').send({ code: 'MATH', name: 'Mathematics' }).expect(201)).body.id;
    const eng = (await ctx.http().post('/api/v1/subjects').send({ code: 'ENG', name: 'English' }).expect(201)).body.id;
    const termId = school.termIds[0]!;
    ctx.as('TEACHER');
    const q = { termId, subjectId: subj };
    await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/scores`).query(q).send({ scores: [{ studentId: s[0], classScore: 31, examScore: 10 }] }).expect(400);
    const saved = await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/scores`).query(q).send({ scores: [
      { studentId: s[0], classScore: 25, examScore: 60 }, { studentId: s[1], classScore: 20, examScore: 50 }, { studentId: s[2], classScore: 25, examScore: 60 },
    ] }).expect(200);
    expect(saved.body).toMatchObject({ classScoreWeight: 30, examScoreWeight: 70, locked: false });
    expect(saved.body.scores.find((x: { studentId: string }) => x.studentId === s[0])).toMatchObject({ total: 85, grade: expect.any(String) });
    await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/scores`).query({ termId, subjectId: eng }).send({ scores: [
      { studentId: s[0], classScore: 20, examScore: 50 }, { studentId: s[1], classScore: 30, examScore: 70 }, { studentId: s[2], classScore: 20, examScore: 50 },
    ] }).expect(200);
    const gen = await ctx.http().post(`/api/v1/terms/${termId}/report-cards/generate`).send({ classId: school.classes.P1A }).expect(202);
    expect(gen.body).toMatchObject({ generated: 3, classSize: 3 });
    const cards = (await ctx.http().get('/api/v1/report-cards').query({ termId, classId: school.classes.P1A }).expect(200)).body;
    const byStudent = (id: string) => cards.find((c: { studentId: string }) => c.studentId === id);
    expect(byStudent(s[1]!)).toMatchObject({ position: 1, positionLabel: '1st', average: 85 });
    expect(byStudent(s[0]!)).toMatchObject({ position: 2, positionTied: true, positionLabel: 'joint 2nd', average: 77.5, attendanceTotal: 1, attendancePresent: 0 });
    expect(byStudent(s[2]!).positionLabel).toBe('joint 2nd');
    await ctx.http().patch(`/api/v1/report-cards/${byStudent(s[0]!).id}`).send({ classTeacherRemark: 'Hardworking', conduct: 'Good' }).expect(200);
    await ctx.http().patch(`/api/v1/report-cards/${byStudent(s[0]!).id}`).send({ headRemark: 'Well done' }).expect(403);
    await ctx.http().post('/api/v1/report-cards/publish').send({ termId, classId: school.classes.P1A }).expect(403);
    ctx.as('HEADTEACHER');
    await ctx.http().patch(`/api/v1/report-cards/${byStudent(s[0]!).id}`).send({ headRemark: 'Well done' }).expect(200);
    const pub = await ctx.http().post('/api/v1/report-cards/publish').send({ termId, classId: school.classes.P1A }).expect(200);
    expect(pub.body.published).toBe(3);
    const pdf = await ctx.http().get(`/api/v1/report-cards/${byStudent(s[0]!).id}/pdf`);
    expect([200, 501]).toContain(pdf.status);
    await ctx.http().post(`/api/v1/terms/${termId}/scores/lock`).expect(200);
    ctx.as('TEACHER');
    const lockedRes = await ctx.http().put(`/api/v1/classes/${school.classes.P1A}/scores`).query(q).send({ scores: [{ studentId: s[0], classScore: 1 }] }).expect(423);
    expect(lockedRes.body.code).toBe('SCORES_LOCKED');
    ctx.as('BURSAR');
    await ctx.http().get(`/api/v1/classes/${school.classes.P1A}/scores`).query(q).expect(403);
    ctx.as('ADMIN');
    await ctx.http().patch(`/api/v1/report-cards/${RANDOM_ID}`).send({ conduct: 'x' }).expect(404);
  });

  it('welfare: incidents restricted to ADMIN/HEADTEACHER/author; health visits audited', async () => {
    ctx.as('TEACHER');
    const inc = await ctx.http().post(`/api/v1/students/${s[1]}/incidents`).send({ occurredAt: '2026-11-16T10:00:00Z', category: 'Fighting', severity: 'medium', description: 'Pushed a classmate at break' }).expect(201);
    expect(inc.body.reportedByUserId).toBe(USER_IDS.TEACHER);
    ctx.as('REGISTRAR');
    await ctx.http().post(`/api/v1/students/${s[1]}/incidents`).send({ occurredAt: '2026-11-16T11:00:00Z', category: 'Late', description: 'Came late twice' }).expect(201);
    await ctx.http().get(`/api/v1/students/${s[1]}/incidents`).expect(403);
    ctx.as('TEACHER');
    const own = await ctx.http().get(`/api/v1/students/${s[1]}/incidents`).expect(200);
    expect(own.body).toHaveLength(1);
    await ctx.http().patch(`/api/v1/incidents/${inc.body.id}`).send({ followUp: 'x' }).expect(403);
    ctx.as('HEADTEACHER');
    expect((await ctx.http().get(`/api/v1/students/${s[1]}/incidents`).expect(200)).body).toHaveLength(2);
    await ctx.http().patch(`/api/v1/incidents/${inc.body.id}`).send({ followUp: 'Parents met the head' }).expect(200);
    await ctx.http().patch(`/api/v1/incidents/${RANDOM_ID}`).send({ followUp: 'x' }).expect(404);
    ctx.as('TEACHER');
    const hv = await ctx.http().post(`/api/v1/students/${s[0]}/health-visits`).send({ complaint: 'Headache', treatmentGiven: 'Rest', sentHome: false }).expect(201);
    expect(hv.body.complaint).toBeUndefined();
    await ctx.http().get(`/api/v1/students/${s[0]}/health-visits`).expect(403);
    ctx.as('REGISTRAR');
    const list = await ctx.http().get(`/api/v1/students/${s[0]}/health-visits`).expect(200);
    expect(list.body[0]).toMatchObject({ complaint: 'Headache' });
    await ctx.http().patch(`/api/v1/health-visits/${hv.body.id}`).send({ sentHome: true }).expect(200);
    expect((await auditEvents(ctx)).some((e) => e.action === 'view' && e.entityType === 'health_visits')).toBe(true);
    await ctx.http().get(`/api/v1/students/${RANDOM_ID}/health-visits`).expect(404);
  });
});
