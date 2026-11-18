import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admissionBody, auditEvents, RANDOM_ID, seedSchool, setupB, type Ctx, type School } from './helpers';

describe('withdrawals and transfers', () => {
  let ctx: Ctx;
  let school: School;
  let studentId = '';
  let wid = '';
  beforeAll(async () => {
    ctx = await setupB();
    school = await seedSchool(ctx.k);
    ctx.as('REGISTRAR');
    studentId = (await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P2A, { firstName: 'Selorm', lastName: 'Agbeko', dateOfBirth: '2018-06-06' })).expect(201)).body.id;
  });
  afterAll(async () => { await ctx?.close(); });

  it('starts a transfer with a clearance checklist; one pending per student', async () => {
    ctx.as('REGISTRAR');
    const r = await ctx.http().post(`/api/v1/students/${studentId}/withdrawals`).send({ type: 'transfer_out', reason: 'Family relocating to Kumasi', effectiveDate: '2026-12-18', destinationSchool: 'Kumasi Model School' }).expect(201);
    wid = r.body.id;
    expect(r.body).toMatchObject({ status: 'pending_clearance', fullyCleared: false, feeBalancePesewas: 0 });
    expect(r.body.outstandingItems).toEqual(['fees', 'books', 'uniform', 'property', 'library']);
    await ctx.http().post(`/api/v1/students/${studentId}/withdrawals`).send({ type: 'withdrawal', reason: 'Again', effectiveDate: '2026-12-18' }).expect(409);
  });

  it('fees clearance needs BURSAR or ADMIN; others clear their items', async () => {
    ctx.as('REGISTRAR');
    const denied = await ctx.http().put(`/api/v1/withdrawals/${wid}/clearance/fees`).send({ cleared: true }).expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    for (const item of ['books', 'uniform', 'property']) await ctx.http().put(`/api/v1/withdrawals/${wid}/clearance/${item}`).send({ cleared: true }).expect(200);
    await ctx.http().put(`/api/v1/withdrawals/${wid}/clearance/library`).send({ cleared: false, notApplicable: true, note: 'No library books borrowed' }).expect(200);
    await ctx.http().put(`/api/v1/withdrawals/${wid}/clearance/canteen`).send({ cleared: true }).expect(404);
    const early = await ctx.http().post(`/api/v1/withdrawals/${wid}/complete`).expect(403);
    expect(early.status).toBe(403); // REGISTRAR lacks withdrawals:complete
    ctx.as('ADMIN');
    const nc = await ctx.http().post(`/api/v1/withdrawals/${wid}/complete`).expect(422);
    expect(nc.body.code).toBe('WITHDRAWAL_NOT_CLEARED');
    ctx.as('BURSAR');
    const f = await ctx.http().put(`/api/v1/withdrawals/${wid}/clearance/fees`).send({ cleared: true, note: 'Balance nil' }).expect(200);
    expect(f.body.clearance.find((c: { item: string }) => c.item === 'fees')).toMatchObject({ cleared: true, balancePesewas: 0 });
    expect(f.body.fullyCleared).toBe(true);
  });

  it('completing sets the status and closes the enrolment; letter gets a number', async () => {
    ctx.as('ADMIN');
    const c = await ctx.http().post(`/api/v1/withdrawals/${wid}/complete`).expect(200);
    expect(c.body.status).toBe('completed');
    const s = await ctx.http().get(`/api/v1/students/${studentId}`).expect(200);
    expect(s.body.status).toBe('transferred_out');
    expect(s.body.currentEnrolment).toBeNull();
    const hist = await ctx.http().get(`/api/v1/students/${studentId}/enrolments`).expect(200);
    expect(hist.body[0]).toMatchObject({ status: 'withdrawn', endDate: '2026-12-18' });
    const letter = await ctx.http().get(`/api/v1/withdrawals/${wid}/transfer-letter.pdf`);
    expect([200, 501]).toContain(letter.status); // 501 until the PDF service lands
    const w = await ctx.k.selectFrom('withdrawals').select('letter_no').where('id', '=', wid).executeTakeFirstOrThrow();
    expect(w.letter_no).toMatch(/^TL-\d{6}$/);
    const again = await ctx.http().get(`/api/v1/withdrawals/${wid}/transfer-letter.pdf`);
    expect(again.status).toBe(letter.status);
    expect((await ctx.k.selectFrom('withdrawals').select('letter_no').where('id', '=', wid).executeTakeFirstOrThrow()).letter_no).toBe(w.letter_no);
    expect((await auditEvents(ctx)).some((e) => e.entityType === 'withdrawal' && e.action === 'update')).toBe(true);
    await ctx.http().post(`/api/v1/withdrawals/${wid}/cancel`).send({}).expect(422);
  });

  it('lists, denies and 404s', async () => {
    ctx.as('HEADTEACHER');
    const l = await ctx.http().get('/api/v1/withdrawals').query({ status: 'completed' }).expect(200);
    expect(l.body.map((x: { id: string }) => x.id)).toContain(wid);
    await ctx.http().post(`/api/v1/students/${studentId}/withdrawals`).send({}).expect(403);
    ctx.as('TEACHER');
    await ctx.http().get('/api/v1/withdrawals').expect(403);
    ctx.as('ADMIN');
    await ctx.http().get(`/api/v1/withdrawals/${RANDOM_ID}`).expect(404);
    await ctx.http().post(`/api/v1/withdrawals/${RANDOM_ID}/complete`).expect(404);
  });
});
