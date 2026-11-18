import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { STUDENT_HEADERS, csvFrom, generateStudentRows } from './fixtures';
import { count, idemKey, setupG, uploadAndValidate, type GCtx } from './helpers';
import { ImportsService } from '../../src/modules/imports/imports.service';
import { IMPORT_TARGET, type ImportTarget } from '../../src/common/contracts';

describe('imports: 1,000 students with the real ImportTarget (Agent G)', () => {
  let ctx: GCtx;
  beforeAll(async () => {
    ctx = await setupG({ capacity: 150 });
    ctx.as('ADMIN');
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  it('dry run + commit of 1,000 rows finishes in under 2 minutes, siblings share guardians', async () => {
    const started = Date.now();
    const job = await uploadAndValidate(ctx, 'students_guardians', csvFrom([STUDENT_HEADERS, ...generateStudentRows(1000)], { delimiter: ';', bom: true }), 'school.csv');
    const dryRunMs = Date.now() - started;
    expect(job.totals).toMatchObject({ rows: 1000, error: 0, duplicate: 0 });
    expect(await count(ctx, 'students')).toBe(0);

    const res = await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
    const totalMs = Date.now() - started;
    expect(res.body.status).toBe('committed');
    expect(res.body.totals).toMatchObject({ committed: 1000, failed: 0 });
    expect(await count(ctx, 'students')).toBe(1000);
    expect(await count(ctx, 'enrolments')).toBe(1000);
    const families = await sql<{ n: number }>`SELECT count(DISTINCT phone_primary)::int AS n FROM app.guardians`.execute(ctx.k);
    expect(await count(ctx, 'guardians')).toBe(families.rows[0]!.n); // one guardian per phone
    expect(await count(ctx, 'guardians')).toBeLessThan(2000);
    const siblings = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT guardian_id FROM app.student_guardians GROUP BY guardian_id HAVING count(*) > 1) x`.execute(ctx.k);
    expect(siblings.rows[0]!.n).toBeGreaterThan(300);
    console.info(`1,000-row import: dry run ${dryRunMs} ms, dry run + commit ${totalMs} ms`);
    expect(totalMs).toBeLessThan(120_000);
  }, 180_000);

  it('a commit that stops part-way resumes without duplicating anyone', async () => {
    const rows = generateStudentRows(450, 2026).map((r) => [r[0]!.replace('OLD-', 'NEW-'), ...r.slice(1)]);
    // different families from the first test: change the surnames/phones so nothing is a duplicate
    const fresh = rows.map((r) => {
      const c = [...r];
      c[3] = `${c[3]}-Badu`;
      c[9] = c[3]!;
      c[11] = c[11]!.replace(/^0244/, '0245');
      c[13] = c[3]!;
      c[16] = c[16]!.replace(/^0200/, '0201');
      return c;
    });
    const job = await uploadAndValidate(ctx, 'students_guardians', csvFrom([STUDENT_HEADERS, ...fresh]), 'second.csv');
    expect(job.totals).toMatchObject({ error: 0, duplicate: 0 });

    // Make the target fail after 250 rows (second batch), as if the server lost power mid-commit.
    const svc = ctx.app.get(ImportsService);
    const real = ctx.app.get<ImportTarget>(IMPORT_TARGET, { strict: false });
    let calls = 0;
    const target = (svc as unknown as { importTarget: ImportTarget });
    target.importTarget = {
      upsertStudentWithGuardians: async (row, tx, actor) => {
        calls += 1;
        if (calls > 250) throw new Error('simulated crash');
        return real.upsertStudentWithGuardians(row, tx, actor);
      },
    };
    const before = await count(ctx, 'students');
    await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
    const partial = await ctx.http().get(`/api/v1/imports/${job.id}`).expect(200);
    expect(partial.body.status).toBe('failed');
    expect(partial.body.totals.committed).toBe(250);
    expect(await count(ctx, 'students')).toBe(before + 250);

    target.importTarget = real;
    const done = await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
    expect(done.body).toMatchObject({ status: 'committed', totals: { committed: 450, failed: 0 } });
    expect(await count(ctx, 'students')).toBe(before + 450);
    await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
    expect(await count(ctx, 'students')).toBe(before + 450);
    const dupRows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT target_student_id FROM import.rows WHERE job_id = ${job.id}::uuid GROUP BY target_student_id HAVING count(*) > 1) x`.execute(ctx.k);
    expect(dupRows.rows[0]!.n).toBe(0);
  }, 180_000);
});
