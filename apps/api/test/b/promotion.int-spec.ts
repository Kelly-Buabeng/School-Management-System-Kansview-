import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER_SERVICE, type LedgerService } from '../../src/common/contracts';
import { admissionBody, auditEvents, RANDOM_ID, seedSchool, setupB, type Ctx, type School } from './helpers';

/** Checksum of every enrolment (business columns) and every student status. */
async function checksum(ctx: Ctx): Promise<string> {
  const r = await sql<{ c: string }>`
    SELECT md5(coalesce((SELECT string_agg(concat_ws('|', id, student_id, class_id, academic_year_id, roll_number, start_date, end_date, status, reason, promotion_run_id), ',' ORDER BY id) FROM app.enrolments), '')
            || '#' || coalesce((SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM app.students), '')) AS c`.execute(ctx.k);
  return r.rows[0]!.c;
}

describe('enrolment and promotion', () => {
  let ctx: Ctx;
  let school: School;
  const ids = {} as Record<"p1a1" | "p1a2" | "p1a3" | "p1b1" | "jhs", string>;
  beforeAll(async () => {
    ctx = await setupB();
    school = await seedSchool(ctx.k);
    ctx.as('REGISTRAR');
    const admit = async (key: keyof typeof ids, classId: string, first: string, dob: string) => {
      ids[key] = (await ctx.http().post('/api/v1/students').send(admissionBody(classId, { firstName: first, lastName: 'Boateng', dateOfBirth: dob })).expect(201)).body.id;
    };
    await admit('p1a1', school.classes.P1A, 'Kwesi', '2019-01-01');
    await admit('p1a2', school.classes.P1A, 'Afia', '2019-02-02');
    await admit('p1b1', school.classes.P1B, 'Kobby', '2019-03-03');
    await admit('jhs', school.classes.JHS3, 'Nana', '2012-04-04');
    await admit('p1a3', school.classes.P1A, 'Akwasi', '2019-05-05');
  });
  afterAll(async () => { await ctx?.close(); });

  it('changes class: closes the old enrolment, opens a new one, keeps history; checks capacity', async () => {
    ctx.as('REGISTRAR');
    const h = await ctx.http().post(`/api/v1/students/${ids.p1a3}/change-class`).send({ classId: school.classes.P1B, reason: 'Stream change requested', effectiveDate: '2026-10-01' }).expect(201);
    expect(h.body).toHaveLength(2);
    expect(h.body[0]).toMatchObject({ classId: school.classes.P1A, endDate: '2026-10-01', status: 'moved' });
    expect(h.body[1]).toMatchObject({ classId: school.classes.P1B, endDate: null, status: 'active', rollNumber: 2 });
    await ctx.http().post(`/api/v1/students/${ids.p1a3}/change-class`).send({ classId: school.classes.NEXT_P1, reason: 'Wrong year' }).expect(422);
    await ctx.k.updateTable('classes').set({ capacity: 2 }).where('id', '=', school.classes.P1B).execute();
    const full = await ctx.http().post(`/api/v1/students/${ids.p1a2}/change-class`).send({ classId: school.classes.P1B, reason: 'Try' }).expect(422);
    expect(full.body.code).toBe('CLASS_AT_CAPACITY');
    await ctx.k.updateTable('classes').set({ capacity: 40 }).where('id', '=', school.classes.P1B).execute();
    ctx.as('TEACHER');
    await ctx.http().post(`/api/v1/students/${ids.p1a3}/change-class`).send({ classId: school.classes.P1A, reason: 'x x x' }).expect(403);
  });

  it('lists a class roll and renumbers alphabetically or manually', async () => {
    ctx.as('REGISTRAR');
    const r = await ctx.http().post(`/api/v1/classes/${school.classes.P1A}/roll-numbers`).send({ mode: 'alphabetical' }).expect(200);
    expect(r.body.students.map((s: { firstName: string; rollNumber: number }) => [s.firstName, s.rollNumber])).toEqual([['Afia', 1], ['Kwesi', 2]]);
    const m = await ctx.http().post(`/api/v1/classes/${school.classes.P1A}/roll-numbers`).send({ mode: 'manual', studentIds: [ids.p1a1, ids.p1a2] }).expect(200);
    expect(m.body.students[0].id).toBe(ids.p1a1);
    await ctx.http().post(`/api/v1/classes/${school.classes.P1A}/roll-numbers`).send({ mode: 'manual', studentIds: [ids.p1a1] }).expect(400);
    await ctx.http().get(`/api/v1/classes/${RANDOM_ID}/students`).expect(404);
    await ctx.http().get(`/api/v1/students/${RANDOM_ID}/enrolments`).expect(404);
  });

  let runId = '';
  let before = '';

  it('builds a draft with default targets (same stream, final level graduates) and arrears flags', async () => {
    ctx.as('ADMIN');
    const ledger = ctx.app.get<LedgerService>(LEDGER_SERVICE, { strict: false });
    ledger.outstandingByStudent = async (studentIds: string[]) => new Map(studentIds.map((i) => [i, i === ids.p1a2 ? 150_000 : 0]));
    const etag = (await ctx.http().get('/api/v1/settings/policies')).headers.etag as string;
    await ctx.http().patch('/api/v1/settings/policies').set('If-Match', etag).send({ 'promotion.block_on_arrears': 'block' }).expect(200);

    const res = await ctx.http().post('/api/v1/promotion-runs').send({ toAcademicYearId: school.nextYearId, classIds: [school.classes.P1A, school.classes.P1B, school.classes.JHS3] }).expect(201);
    runId = res.body.id;
    expect(res.body).toMatchObject({ status: 'draft', arrearsPolicy: 'block' });
    const item = (sid: string | undefined) => res.body.items.find((i: { studentId: string }) => i.studentId === sid);
    expect(item(ids.p1a1)).toMatchObject({ action: 'promote', targetClassId: school.classes.NEXT_P2A });
    expect(item(ids.p1b1)).toMatchObject({ action: 'promote', targetClassId: school.classes.NEXT_P2B });
    expect(item(ids.jhs)).toMatchObject({ action: 'graduate', targetClassId: null });
    expect(item(ids.p1a2)).toMatchObject({ arrearsFlag: true, outstandingPesewas: 150_000, blocked: true });
    ctx.as('BURSAR');
    const view = await ctx.http().get(`/api/v1/promotion-runs/${runId}`).expect(200);
    expect(view.body.items).toHaveLength(5);
    await ctx.http().post('/api/v1/promotion-runs').send({ toAcademicYearId: school.nextYearId, classIds: [school.classes.P1A] }).expect(403);
  });

  it('blocks commit until arrears have an override reason; applies exceptions', async () => {
    ctx.as('ADMIN');
    const run = (await ctx.http().get(`/api/v1/promotion-runs/${runId}`)).body;
    const item = (sid: string | undefined) => run.items.find((i: { studentId: string }) => i.studentId === sid);
    await ctx.http().patch(`/api/v1/promotion-runs/${runId}/items/${item(ids.p1a3).id}`).send({ action: 'repeat', targetClassId: school.classes.NEXT_P1 }).expect(200);
    await ctx.http().patch(`/api/v1/promotion-runs/${runId}/items/${item(ids.p1b1).id}`).send({ action: 'repeat', targetClassId: school.classes.P1A }).expect(400);
    await ctx.http().patch(`/api/v1/promotion-runs/${runId}/items/${item(ids.p1b1).id}`).send({ action: 'transfer_out' }).expect(200);
    await ctx.http().post(`/api/v1/promotion-runs/${runId}/commit`).expect(400); // Idempotency-Key required
    const blocked = await ctx.http().post(`/api/v1/promotion-runs/${runId}/commit`).set('Idempotency-Key', 'promo-commit-key-0001').expect(422);
    expect(blocked.body.code).toBe('PROMOTION_BLOCKED_ARREARS');
    await ctx.http().patch(`/api/v1/promotion-runs/${runId}/items/${item(ids.p1a2).id}`).send({ overrideReason: 'Agreed payment plan with mother' }).expect(200);
  });

  it('commits in one transaction; history intact; replay is harmless', async () => {
    ctx.as('ADMIN');
    before = await checksum(ctx);
    const r = await ctx.http().post(`/api/v1/promotion-runs/${runId}/commit`).set('Idempotency-Key', 'promo-commit-key-0002').expect(200);
    expect(r.body.status).toBe('committed');
    expect(r.body.undoDeadline).toBeTruthy();
    const h = (await ctx.http().get(`/api/v1/students/${ids.p1a1}/enrolments`).expect(200)).body;
    expect(h.at(-2)).toMatchObject({ classId: school.classes.P1A, status: 'completed' });
    expect(h.at(-1)).toMatchObject({ classId: school.classes.NEXT_P2A, status: 'active', endDate: null });
    const jhs = (await ctx.http().get(`/api/v1/students/${ids.jhs}`).expect(200)).body;
    expect(jhs.status).toBe('alumni');
    expect((await ctx.http().get(`/api/v1/students/${ids.p1b1}`)).body.status).toBe('transferred_out');
    expect((await ctx.http().get(`/api/v1/students/${ids.p1a3}/enrolments`)).body.at(-1)).toMatchObject({ classId: school.classes.NEXT_P1 });
    const again = await ctx.http().post(`/api/v1/promotion-runs/${runId}/commit`).set('Idempotency-Key', 'promo-commit-key-0002').expect(200);
    expect(again.body.status).toBe('committed');
    expect((await ctx.k.selectFrom('enrolments').select('id').where('promotion_run_id', '=', runId).execute())).toHaveLength(3);
    expect((await auditEvents(ctx)).some((e) => e.entityType === 'promotion_run' && e.action === 'update')).toBe(true);
  });

  it('undo restores exactly the previous state (checksum), and refuses a second undo', async () => {
    ctx.as('REGISTRAR');
    await ctx.http().post(`/api/v1/promotion-runs/${runId}/undo`).send({ reason: 'Wrong classes chosen' }).expect(403);
    ctx.as('ADMIN');
    await ctx.http().post(`/api/v1/promotion-runs/${runId}/undo`).send({}).expect(400);
    const r = await ctx.http().post(`/api/v1/promotion-runs/${runId}/undo`).send({ reason: 'Wrong classes chosen' }).expect(200);
    expect(r.body.status).toBe('undone');
    expect(await checksum(ctx)).toBe(before);
    const again = await ctx.http().post(`/api/v1/promotion-runs/${runId}/undo`).send({ reason: 'Again please' }).expect(422);
    expect(again.body.code).toBe('PROMOTION_INVALID_STATE');
  });

  it('refuses undo after the window and when later records depend on it', async () => {
    ctx.as('ADMIN');
    const mk = async () => {
      const res = await ctx.http().post('/api/v1/promotion-runs').send({ toAcademicYearId: school.nextYearId, classIds: [school.classes.P1A] }).expect(201);
      for (const it of res.body.items) if (it.arrearsFlag) await ctx.http().patch(`/api/v1/promotion-runs/${res.body.id}/items/${it.id}`).send({ overrideReason: 'Payment plan agreed' }).expect(200);
      await ctx.http().post(`/api/v1/promotion-runs/${res.body.id}/commit`).set('Idempotency-Key', `promo-key-${res.body.id}`).expect(200);
      return res.body.id as string;
    };
    const late = await mk();
    await ctx.k.updateTable('promotion_runs').set({ undo_deadline: new Date(Date.now() - 1000) }).where('id', '=', late).execute();
    const closed = await ctx.http().post(`/api/v1/promotion-runs/${late}/undo`).send({ reason: 'Too late now' }).expect(422);
    expect(closed.body.code).toBe('PROMOTION_UNDO_WINDOW_CLOSED');
    // re-open window, then make a later class change → dependent
    await ctx.k.updateTable('promotion_runs').set({ undo_deadline: new Date(Date.now() + 86_400_000) }).where('id', '=', late).execute();
    await ctx.http().post(`/api/v1/students/${ids.p1a1}/change-class`).send({ classId: school.classes.NEXT_P2B, reason: 'Moved stream', effectiveDate: '2027-09-10' }).expect(201);
    const dep = await ctx.http().post(`/api/v1/promotion-runs/${late}/undo`).send({ reason: 'Wrong classes' }).expect(422);
    expect(dep.body.code).toBe('PROMOTION_UNDO_HAS_DEPENDENTS');
    expect(dep.body.detail).toContain('changed class');
    await ctx.http().get(`/api/v1/promotion-runs/${RANDOM_ID}`).expect(404);
    await ctx.http().post(`/api/v1/promotion-runs/${RANDOM_ID}/undo`).send({ reason: 'nothing here' }).expect(404);
  });
});
