import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { BALANCE_HEADERS, STAFF_HEADERS, STUDENT_HEADERS, csvFrom, generateStudentRows, messyStudentsWorkbook } from './fixtures';
import { count, idemKey, setupG, uploadAndValidate, USER_IDS, type GCtx } from './helpers';
import { xlsxBomb } from './zip-bomb';

const RANDOM_ID = '01900000-0000-7000-8000-00000000beef';

function binary(res: import('supertest').Response, cb: (err: Error | null, body: Buffer) => void) {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

async function readXlsx(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
}

describe('imports (Agent G)', () => {
  let ctx: GCtx;
  beforeAll(async () => {
    ctx = await setupG();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('templates', () => {
    it('ADMIN downloads each template as xlsx with the real class list', async () => {
      ctx.as('ADMIN');
      for (const t of ['students_guardians', 'staff', 'opening_balances']) {
        const res = await ctx.http().get(`/api/v1/imports/templates/${t}`).buffer(true).parse(binary).expect(200);
        expect(res.headers['content-type']).toContain('spreadsheetml');
        expect(res.headers['content-disposition']).toContain('.xlsx');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body as ArrayBuffer);
        expect(wb.worksheets[0]!.name).toBe('Instructions');
        if (t === 'students_guardians') expect(wb.getWorksheet('Lists')!.getSheetValues().flat()).toContain('JHS2 B');
        if (t === 'opening_balances') expect(wb.getWorksheet('Lists')!.getSheetValues().flat()).toContain('2026/2027 Term 2');
      }
    });
    it('role denials', async () => {
      ctx.as('TEACHER');
      await ctx.http().get('/api/v1/imports/templates/students_guardians').expect(403);
      ctx.as('HEADTEACHER');
      await ctx.http().get('/api/v1/imports/templates/students_guardians').expect(403);
      ctx.as('BURSAR');
      await ctx.http().get('/api/v1/imports/templates/students_guardians').expect(403);
      await ctx.http().get('/api/v1/imports/templates/opening_balances').expect(200);
      ctx.as('REGISTRAR');
      await ctx.http().get('/api/v1/imports/templates/staff').expect(403);
      await ctx.http().get('/api/v1/imports/templates/nope').expect(400);
    });
  });

  describe('messy students workbook: upload → dry run → fix → commit', () => {
    let jobId: string;

    it('upload stores the rows and nothing else', async () => {
      ctx.as('REGISTRAR');
      const before = await count(ctx, 'students');
      const res = await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').attach('file', await messyStudentsWorkbook(), 'pupils.xlsx').expect(201);
      jobId = res.body.id;
      expect(res.body).toMatchObject({ type: 'students_guardians', status: 'uploaded', originalFilename: 'pupils.xlsx', missingColumns: [] });
      expect(res.body.totals.rows).toBe(8);
      expect(await count(ctx, 'students')).toBe(before);
      const job = await ctx.k.selectFrom('import.jobs').select(['file_id', 'created_by']).where('id', '=', jobId).executeTakeFirstOrThrow();
      expect(job.file_id).toBeTruthy(); // original kept through the upload pipeline
      expect(job.created_by).toBe(USER_IDS.REGISTRAR);
    });

    it('dry run classifies rows and writes nothing outside staging', async () => {
      const before = await Promise.all([count(ctx, 'students'), count(ctx, 'guardians'), count(ctx, 'enrolments')]);
      const res = await ctx.http().post(`/api/v1/imports/${jobId}/validate`).expect(202);
      expect(res.body.status).toBe('validated');
      expect(res.body.totals).toMatchObject({ rows: 8, error: 4, duplicate: 0 });
      expect(res.body.totals.valid + res.body.totals.warning).toBe(4);
      expect(await Promise.all([count(ctx, 'students'), count(ctx, 'guardians'), count(ctx, 'enrolments')])).toEqual(before);

      const errors = await ctx.http().get(`/api/v1/imports/${jobId}/rows?status=error`).expect(200);
      expect(errors.body.total).toBe(4);
      expect(errors.body.data.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([7, 9, 10, 11]);
      const page = await ctx.http().get(`/api/v1/imports/${jobId}/rows?page=2&pageSize=5`).expect(200);
      expect(page.body).toMatchObject({ page: 2, pageSize: 5, total: 8 });
      expect(page.body.data).toHaveLength(3);
      await ctx.http().get(`/api/v1/imports/${jobId}/rows?status=bogus`).expect(400);
    });

    it('error report has the original columns plus Errors', async () => {
      const res = await ctx.http().get(`/api/v1/imports/${jobId}/error-report.xlsx`).buffer(true).parse(binary).expect(200);
      const ws = await readXlsx(res.body as Buffer);
      const header = (ws.getRow(1).values as unknown[]).slice(1);
      expect(header.slice(0, 3)).toEqual(['Admission No', 'FIRST NAME', 'SURNAME']);
      expect(header).toContain('Errors');
      expect(ws.actualRowCount).toBe(5);
      const errorsCol = header.indexOf('Errors') + 1;
      expect(String(ws.getRow(2).getCell(errorsCol).value)).toMatch(/not a real date/);
    });

    it('resolve: skip a row and undo it; errors cannot be resolved', async () => {
      await ctx.http().patch(`/api/v1/imports/${jobId}/rows/12`).send({ action: 'skip' }).expect(200);
      let job = await ctx.http().get(`/api/v1/imports/${jobId}`).expect(200);
      expect(job.body.totals.skipped).toBe(1);
      await ctx.http().patch(`/api/v1/imports/${jobId}/rows/12`).send({ action: 'include' }).expect(200);
      job = await ctx.http().get(`/api/v1/imports/${jobId}`).expect(200);
      expect(job.body.totals.skipped).toBe(0);
      await ctx.http().patch(`/api/v1/imports/${jobId}/rows/7`).send({ action: 'skip' }).expect(422);
      await ctx.http().patch(`/api/v1/imports/${jobId}/rows/4`).send({ action: 'create_new' }).expect(422);
      await ctx.http().patch(`/api/v1/imports/${jobId}/rows/999`).send({ action: 'skip' }).expect(404);
      await ctx.http().patch(`/api/v1/imports/${jobId}/rows/4`).send({ action: 'skip', extra: 1 }).expect(400);
    });

    it('REGISTRAR cannot commit; ADMIN commit needs an Idempotency-Key', async () => {
      await ctx.http().post(`/api/v1/imports/${jobId}/commit`).set('Idempotency-Key', idemKey()).expect(403);
      ctx.as('ADMIN');
      await ctx.http().post(`/api/v1/imports/${jobId}/commit`).expect(400);
    });

    it('commit writes valid rows, links siblings by guardian phone and is audited', async () => {
      const key = idemKey();
      const res = await ctx.http().post(`/api/v1/imports/${jobId}/commit`).set('Idempotency-Key', key).expect(202);
      expect(res.body).toMatchObject({ status: 'committed', committedBy: USER_IDS.ADMIN });
      expect(res.body.totals).toMatchObject({ committed: 4, failed: 0, toCommit: 0 });
      expect(await count(ctx, 'students')).toBe(4);
      // Kwame (row 4), Ama (row 6) and Abena (row 12) share Akosua Mensah's phone → one guardian, three children.
      const shared = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.student_guardians sg JOIN app.guardians g ON g.id = sg.guardian_id WHERE g.phone_primary = '+233244000001'`.execute(ctx.k);
      expect(shared.rows[0]!.n).toBe(3);
      expect((await ctx.k.selectFrom('guardians').select('id').where('phone_primary', '=', '+233244000001').execute()).length).toBe(1);
      const rows = await ctx.k.selectFrom('import.rows').select(['row_number', 'target_student_id', 'committed_at']).where('job_id', '=', jobId).where('committed_at', 'is not', null).execute();
      expect(rows).toHaveLength(4);
      const audit = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit.events WHERE entity_type = 'import_commit' AND entity_id::text = ${jobId}`.execute(ctx.k);
      expect(audit.rows[0]!.n).toBe(1);

      const replay = await ctx.http().post(`/api/v1/imports/${jobId}/commit`).set('Idempotency-Key', key).expect(202);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      await ctx.http().post(`/api/v1/imports/${jobId}/commit`).set('Idempotency-Key', idemKey()).expect(202);
      expect(await count(ctx, 'students')).toBe(4);
      await ctx.http().post(`/api/v1/imports/${jobId}/validate`).expect(409);
    });

    it('the same file again: every child is a duplicate of the committed one and cannot be committed blindly', async () => {
      ctx.as('ADMIN');
      const job = await uploadAndValidate(ctx, 'students_guardians', await messyStudentsWorkbook(), 'again.xlsx');
      expect(job.totals.duplicate).toBe(4);
      await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(422);
      const dupes = await ctx.http().get(`/api/v1/imports/${job.id}/rows?status=duplicate`).expect(200);
      const [first, ...rest] = dupes.body.data as Array<{ rowNumber: number; duplicates: Array<{ studentId: string }> }>;
      await ctx.http().patch(`/api/v1/imports/${job.id}/rows/${first!.rowNumber}`).send({ action: 'link_existing', existingId: RANDOM_ID }).expect(422);
      const linked = await ctx.http().patch(`/api/v1/imports/${job.id}/rows/${first!.rowNumber}`).send({ action: 'link_existing' }).expect(200);
      expect(linked.body.resolution).toEqual({ action: 'link_existing', existingId: first!.duplicates[0]!.studentId });
      for (const r of rest) await ctx.http().patch(`/api/v1/imports/${job.id}/rows/${r.rowNumber}`).send({ action: 'skip' }).expect(200);
      const done = await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
      expect(done.body.totals).toMatchObject({ committed: 1, skipped: 3 });
      expect(await count(ctx, 'students')).toBe(4);
      const row = await ctx.k.selectFrom('import.rows').select('target_student_id').where('job_id', '=', job.id).where('row_number', '=', first!.rowNumber).executeTakeFirstOrThrow();
      expect(row.target_student_id).toBe(first!.duplicates[0]!.studentId);
    });
  });

  describe('access control and IDOR', () => {
    let studentJob: string;
    beforeAll(async () => {
      ctx.as('REGISTRAR');
      const res = await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').attach('file', csvFrom([STUDENT_HEADERS, ...generateStudentRows(2)]), 'two.csv').expect(201);
      studentJob = res.body.id;
    });

    it('roles without imports access are denied', async () => {
      for (const role of ['TEACHER', 'HEADTEACHER'] as const) {
        ctx.as(role);
        await ctx.http().get('/api/v1/imports').expect(403);
        await ctx.http().get(`/api/v1/imports/${studentJob}`).expect(403);
        await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').attach('file', csvFrom([STUDENT_HEADERS, ...generateStudentRows(1)]), 'x.csv').expect(403);
        await ctx.http().post(`/api/v1/imports/${studentJob}/commit`).set('Idempotency-Key', idemKey()).expect(403);
      }
    });

    it('BURSAR can only import opening balances; other jobs are invisible (404)', async () => {
      ctx.as('BURSAR');
      await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').attach('file', csvFrom([STUDENT_HEADERS, ...generateStudentRows(1)]), 'x.csv').expect(403);
      await ctx.http().get(`/api/v1/imports/${studentJob}`).expect(404);
      await ctx.http().get(`/api/v1/imports/${studentJob}/rows`).expect(404);
      await ctx.http().post(`/api/v1/imports/${studentJob}/validate`).expect(404);
      await ctx.http().get(`/api/v1/imports/${studentJob}/error-report.xlsx`).expect(404);
      await ctx.http().patch(`/api/v1/imports/${studentJob}/rows/2`).send({ action: 'skip' }).expect(404);
      const list = await ctx.http().get('/api/v1/imports').expect(200);
      expect(list.body.data.every((j: { type: string }) => j.type === 'opening_balances')).toBe(true);
    });

    it('REGISTRAR cannot import staff or balances; unknown ids are 404', async () => {
      ctx.as('REGISTRAR');
      await ctx.http().post('/api/v1/imports').field('type', 'staff').attach('file', csvFrom([STAFF_HEADERS, ['', 'Ama', 'Darko', 'F', '', '0244000777', '', 'Teaching', '', '']]), 's.csv').expect(403);
      await ctx.http().post('/api/v1/imports').field('type', 'opening_balances').attach('file', csvFrom([BALANCE_HEADERS, ['', 'X', '', '1', '2026/2027 Term 1', '']]), 'b.csv').expect(403);
      await ctx.http().get(`/api/v1/imports/${RANDOM_ID}`).expect(404);
      await ctx.http().get('/api/v1/imports/not-a-uuid').expect(404);
    });

    it('upload rejects bad input', async () => {
      ctx.as('ADMIN');
      await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').expect(400);
      await ctx.http().post('/api/v1/imports').field('type', 'pupils').attach('file', csvFrom([STUDENT_HEADERS]), 'x.csv').expect(400);
      const bad = await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').attach('file', Buffer.from('just some words\nnothing here'), 'x.csv').expect(400);
      expect(bad.body.code).toBe('IMPORT_FILE_UNREADABLE');
    });

    it('a zip-bomb workbook is refused with 422 problem+json and creates no job (CP5-03)', async () => {
      ctx.as('REGISTRAR');
      const jobs = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM import.jobs`.execute(ctx.k)).rows[0]!.n;
      const jobsBefore = await jobs();
      for (const mode of ['honest', 'lying'] as const) {
        const res = await ctx.http().post('/api/v1/imports').field('type', 'students_guardians').attach('file', await xlsxBomb(120, mode), 'pupils.xlsx');
        expect(res.status).toBe(422);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('IMPORT_FILE_UNREADABLE');
      }
      expect(await jobs()).toBe(jobsBefore);
    });
  });

  describe('opening balances', () => {
    it('BURSAR uploads and checks; only ADMIN commits; posts opening_balance ledger entries once', async () => {
      const student = await ctx.k.selectFrom('students').select(['id', 'student_code', 'first_name', 'last_name']).orderBy('student_code').executeTakeFirstOrThrow();
      const legacy = await sql<{ legacy: string; id: string }>`SELECT normalised->>'legacyId' AS legacy, target_student_id AS id FROM import.rows WHERE committed_at IS NOT NULL AND target_student_id <> ${student.id}::uuid AND normalised->>'legacyId' IS NOT NULL LIMIT 1`.execute(ctx.k);
      const rows = [
        BALANCE_HEADERS,
        [student.student_code, '', `${student.first_name} ${student.last_name}`, '1,250.00', '2026/2027 Term 1', 'Arrears 2025/2026'],
        ['', legacy.rows[0]!.legacy, '', '(150)', '2026/2027 Term 1', 'Paid ahead'],
        ['', 'OLD-NOPE', '', '10', '2026/2027 Term 1', ''],
      ];
      ctx.as('BURSAR');
      const job = await uploadAndValidate(ctx, 'opening_balances', csvFrom(rows), 'balances.csv');
      expect(job.totals).toMatchObject({ rows: 3, error: 1 });
      await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(403);
      ctx.as(['ADMIN']);
      const before = await count(ctx, 'ledger_entries');
      const res = await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
      expect(res.body.totals.committed).toBe(2);
      expect(await count(ctx, 'ledger_entries')).toBe(before + 2);
      const entries = await ctx.k.selectFrom('ledger_entries').select(['student_id', 'amount_pesewas', 'entry_type', 'description']).where('entry_type', '=', 'opening_balance').orderBy('amount_pesewas').execute();
      expect(entries.map((e) => [e.student_id, Number(e.amount_pesewas)])).toEqual([[legacy.rows[0]!.id, -15000], [student.id, 125000]]);

      ctx.as('BURSAR');
      const again = await uploadAndValidate(ctx, 'opening_balances', csvFrom(rows.slice(0, 2)), 'balances-again.csv');
      expect(again.totals.error).toBe(1);
      const r = await ctx.http().get(`/api/v1/imports/${again.id}/rows`).expect(200);
      expect(r.body.data[0].messages.map((m: { code: string }) => m.code)).toContain('OPENING_BALANCE_EXISTS');
    });
  });

  describe('staff', () => {
    it('imports staff, generates missing staff IDs and rejects an existing one', async () => {
      ctx.as('ADMIN');
      const rows = [
        STAFF_HEADERS,
        ['ST-001', 'yaa', 'ASANTEWAA', 'F', '02/05/1988', '0244000501', 'yaa@example.com', 'Teaching', 'Class Teacher', '01/09/2015'],
        ['', 'Ibrahim', 'Mahama', 'M', '', '0200000502', '', 'Non-teaching', 'Driver', ''],
      ];
      const job = await uploadAndValidate(ctx, 'staff', csvFrom(rows), 'staff.csv');
      expect(job.totals.error).toBe(0);
      await ctx.http().post(`/api/v1/imports/${job.id}/commit`).set('Idempotency-Key', idemKey()).expect(202);
      const staff = await ctx.k.selectFrom('staff').select(['staff_code', 'first_name', 'staff_type']).orderBy('staff_code').execute();
      expect(staff).toEqual([
        { staff_code: 'ST-001', first_name: 'Yaa', staff_type: 'teaching' },
        { staff_code: 'STF-0001', first_name: 'Ibrahim', staff_type: 'non_teaching' },
      ]);
      const again = await uploadAndValidate(ctx, 'staff', csvFrom(rows.slice(0, 2)), 'staff2.csv');
      expect(again.totals.error).toBe(1);
    });
  });
});
