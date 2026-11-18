import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, RANDOM_ID, setupB, type Ctx } from './helpers';

describe('academic setup and settings', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setupB(); });
  afterAll(async () => { await ctx?.close(); });

  const year = {
    name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31',
    terms: [
      { number: 1, startDate: '2026-09-07', endDate: '2026-12-18' },
      { number: 2, startDate: '2027-01-11', endDate: '2027-04-09' },
      { number: 3, startDate: '2027-04-26', endDate: '2027-07-23' },
    ],
  };
  let yearId = '';
  let levelP1 = '';
  let levelP2 = '';
  let classId = '';

  it('creates a year with its 3 terms, audited', async () => {
    ctx.as('ADMIN');
    const res = await ctx.http().post('/api/v1/academic-years').send(year).expect(201);
    expect(res.body.terms).toHaveLength(3);
    expect(res.body.terms[0]).toMatchObject({ number: 1, name: 'Term 1', startDate: '2026-09-07' });
    yearId = res.body.id;
    expect((await auditEvents(ctx)).some((e) => e.action === 'create' && e.entityType === 'academic_year')).toBe(true);
  });

  it('rejects overlapping years, bad terms and unknown fields', async () => {
    ctx.as('ADMIN');
    await ctx.http().post('/api/v1/academic-years').send({ ...year, name: '2027/2028' }).expect(409);
    await ctx.http().post('/api/v1/academic-years').send({ ...year, name: '2030/2031', startDate: '2030-09-01', endDate: '2031-07-31' }).expect(400);
    const r = await ctx.http().post('/api/v1/academic-years').send({ ...year, status: 'current' }).expect(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
  });

  it('sets the current year and picks a current term', async () => {
    ctx.as('ADMIN');
    const res = await ctx.http().post(`/api/v1/academic-years/${yearId}/set-current`).expect(200);
    expect(res.body.status).toBe('current');
    expect(res.body.terms.filter((t: { status: string }) => t.status === 'current')).toHaveLength(1);
    const t2 = res.body.terms[1].id;
    const upd = await ctx.http().patch(`/api/v1/terms/${t2}`).send({ status: 'current', name: 'Second Term' }).expect(200);
    expect(upd.body.terms.map((t: { status: string }) => t.status)).toEqual(['planned', 'current', 'planned']);
    await ctx.http().patch(`/api/v1/terms/${t2}`).send({ endDate: '2027-09-30' }).expect(400);
  });

  it('creates levels with weights and classes with capacity', async () => {
    ctx.as('ADMIN');
    levelP2 = (await ctx.http().post('/api/v1/levels').send({ code: 'X2', name: 'Extra 2', sortOrder: 510 }).expect(201)).body.id;
    const p1 = await ctx.http().post('/api/v1/levels').send({ code: 'X1', name: 'Extra 1', sortOrder: 500, nextLevelId: levelP2, classScoreWeight: 40, examScoreWeight: 60 }).expect(201);
    levelP1 = p1.body.id;
    expect(p1.body).toMatchObject({ classScoreWeight: 40, examScoreWeight: 60, nextLevelId: levelP2 });
    await ctx.http().post('/api/v1/levels').send({ code: 'X3', name: 'X3', sortOrder: 520, classScoreWeight: 40, examScoreWeight: 70 }).expect(400);
    await ctx.http().post('/api/v1/levels').send({ code: 'X1', name: 'Dup', sortOrder: 599 }).expect(409);
    const c = await ctx.http().post('/api/v1/classes').send({ academicYearId: yearId, levelId: levelP1, stream: 'A', capacity: 30 }).expect(201);
    classId = c.body.id;
    expect(c.body).toMatchObject({ displayName: 'Extra 1 A', capacity: 30, enrolledCount: 0, availablePlaces: 30 });
    await ctx.http().post('/api/v1/classes').send({ academicYearId: yearId, levelId: levelP1, stream: 'A' }).expect(409);
    const list = await ctx.http().get('/api/v1/classes').expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(classId);
    const upd = await ctx.http().patch(`/api/v1/classes/${classId}`).send({ capacity: 35 }).expect(200);
    expect(upd.body.capacity).toBe(35);
  });

  it('manages subjects, level subjects and grading scales', async () => {
    ctx.as('ADMIN');
    const math = (await ctx.http().post('/api/v1/subjects').send({ code: 'math', name: 'Mathematics' }).expect(201)).body;
    expect(math.code).toBe('MATH');
    const eng = (await ctx.http().post('/api/v1/subjects').send({ code: 'ENG', name: 'English Language' }).expect(201)).body;
    const ls = await ctx.http().put(`/api/v1/levels/${levelP1}/subjects`).send({ subjectIds: [eng.id, math.id] }).expect(200);
    expect(ls.body.subjects.map((s: { code: string }) => s.code)).toEqual(['ENG', 'MATH']);
    const bands = [{ minScore: 80, maxScore: 100, grade: '1', remark: 'Highest' }, { minScore: 0, maxScore: 79, grade: '2', remark: 'Lower' }];
    const g = await ctx.http().post('/api/v1/grading-scales').send({ name: 'Basic', isDefault: true, bands }).expect(201);
    expect((await ctx.http().get('/api/v1/grading-scales').expect(200)).body.filter((s: { isDefault: boolean }) => s.isDefault)).toHaveLength(1);
    expect(g.body.bands).toHaveLength(2);
    await ctx.http().put(`/api/v1/grading-scales/${g.body.id}`).send({ name: 'Basic', bands: [...bands, { minScore: 50, maxScore: 60, grade: 'X' }] }).expect(400);
    await ctx.http().put(`/api/v1/grading-scales/${RANDOM_ID}`).send({ name: 'Nope', bands }).expect(404);
  });

  it('updates policies with If-Match and validates each key', async () => {
    ctx.as('ADMIN');
    const get = await ctx.http().get('/api/v1/settings/policies').expect(200);
    expect(get.body['promotion.block_on_arrears']).toBe('warn');
    expect(get.body['finance.allocation_order']).toBe('oldest_first_by_priority');
    const etag = String(get.headers.etag);
    await ctx.http().patch('/api/v1/settings/policies').send({ 'promotion.block_on_arrears': 'block' }).expect(428);
    await ctx.http().patch('/api/v1/settings/policies').set('If-Match', etag).send({ 'promotion.block_on_arrears': 'maybe' }).expect(400);
    await ctx.http().patch('/api/v1/settings/policies').set('If-Match', etag).send({ 'not.a.key': 1 }).expect(400);
    const ok = await ctx.http().patch('/api/v1/settings/policies').set('If-Match', etag).send({ 'promotion.block_on_arrears': 'block', 'attendance.sms_on_absence': false }).expect(200);
    expect(ok.body['promotion.block_on_arrears']).toBe('block');
    await ctx.http().patch('/api/v1/settings/policies').set('If-Match', etag).send({ 'promotion.block_on_arrears': 'off' }).expect(412);
    expect((await auditEvents(ctx)).some((e) => e.entityType === 'settings')).toBe(true);
  });

  it('updates the school profile with If-Match', async () => {
    ctx.as('ADMIN');
    const g = await ctx.http().get('/api/v1/settings/school').expect(200);
    const res = await ctx.http().patch('/api/v1/settings/school').set('If-Match', String(g.body.version)).send({ name: 'Kansview School', schoolCode: 'KSV' }).expect(200);
    expect(res.body).toMatchObject({ name: 'Kansview School', schoolCode: 'KSV', version: g.body.version + 1 });
    await ctx.http().patch('/api/v1/settings/school').set('If-Match', '0').send({ motto: 'x' }).expect(412);
  });

  it('denies roles without permission (403) and unknown ids (404)', async () => {
    ctx.as('REGISTRAR');
    await ctx.http().get('/api/v1/classes').expect(200);
    await ctx.http().post('/api/v1/levels').send({ code: 'P9', name: 'P9', sortOrder: 99 }).expect(403);
    await ctx.http().patch('/api/v1/settings/policies').set('If-Match', 'x').send({}).expect(403);
    ctx.as('TEACHER');
    await ctx.http().post('/api/v1/grading-scales').send({}).expect(403);
    await ctx.http().patch(`/api/v1/classes/${classId}`).send({ capacity: 3 }).expect(403);
    ctx.as('BURSAR');
    await ctx.http().post(`/api/v1/academic-years/${yearId}/set-current`).expect(403);
    ctx.as('ADMIN');
    await ctx.http().get(`/api/v1/classes/${RANDOM_ID}`).expect(404);
    await ctx.http().get('/api/v1/classes/not-a-uuid').expect(404);
    await ctx.http().patch(`/api/v1/terms/${RANDOM_ID}`).send({ name: 'x' }).expect(404);
  });
});
