import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPORT_TARGET, STUDENT_LOOKUP, type ImportStudentRow, type ImportTarget, type StudentLookup } from '../../src/common/contracts';
import { KYSELY, type Db } from '../../src/common/db/database.module';
import { isValidStudentCode } from './code';
import { seedSchool, setupB, testPhone, USER_IDS, type Ctx, type School } from './helpers';

describe('StudentLookup and ImportTarget contracts', () => {
  let ctx: Ctx;
  let school: School;
  let lookup: StudentLookup;
  let target: ImportTarget;
  let db: Db;
  beforeAll(async () => {
    ctx = await setupB();
    school = await seedSchool(ctx.k);
    lookup = ctx.app.get(STUDENT_LOOKUP, { strict: false });
    target = ctx.app.get(IMPORT_TARGET, { strict: false });
    db = ctx.app.get(KYSELY, { strict: false });
  });
  afterAll(async () => { await ctx?.close(); });

  const phone = testPhone();
  const row = (first: string, dob: string, classId: string): ImportStudentRow => ({
    firstName: first, lastName: 'Darko', dateOfBirth: dob, gender: 'female', admissionDate: '2026-09-07', classId, legacyId: `OLD-${first}`,
    medical: { allergies: 'Dust', alertSummary: 'Asthma: inhaler in bag' },
    guardians: [{ firstName: 'Esther', lastName: 'Darko', relationship: 'Mother', phonePrimary: phone.replace('+233', '0'), isPrimary: true, isFeePayer: true, canPickUp: true }],
  });
  let first = { studentId: '', studentCode: '', guardianIds: [] as string[] };

  it('imports a row through the admission rules and de-duplicates guardians by phone (siblings link)', async () => {
    first = await db.transaction().execute((tx) => target.upsertStudentWithGuardians(row('Efua', '2019-08-08', school.classes.P1A), tx, USER_IDS.ADMIN));
    expect(isValidStudentCode(first.studentCode)).toBe(true);
    const second = await db.transaction().execute((tx) => target.upsertStudentWithGuardians(row('Esi', '2020-09-09', school.classes.KG1), tx, USER_IDS.ADMIN));
    expect(second.guardianIds).toEqual(first.guardianIds);
    const sib = await ctx.k.selectFrom('v_sibling_links').selectAll().where('student_id', '=', second.studentId).execute();
    expect(sib.map((s) => s.sibling_student_id)).toEqual([first.studentId]);
    const hist = await ctx.k.selectFrom('student_status_history').select(['source', 'reason']).where('student_id', '=', first.studentId).executeTakeFirstOrThrow();
    expect(hist).toMatchObject({ source: 'import', reason: 'Imported (old ID OLD-Efua)' });
  });

  it('rolls back with the caller transaction', async () => {
    const before = (await ctx.k.selectFrom('students').select('id').execute()).length;
    await expect(db.transaction().execute(async (tx) => {
      await target.upsertStudentWithGuardians(row('Rollback', '2018-01-01', school.classes.P1B), tx, USER_IDS.ADMIN);
      throw new Error('batch failed');
    })).rejects.toThrow('batch failed');
    expect((await ctx.k.selectFrom('students').select('id').execute()).length).toBe(before);
  });

  it('rejects duplicates and bad phones like manual admission', async () => {
    await expect(db.transaction().execute((tx) => target.upsertStudentWithGuardians(row('Efua', '2019-08-08', school.classes.P1B), tx, USER_IDS.ADMIN))).rejects.toMatchObject({ code: 'STUDENT_POSSIBLE_DUPLICATE' });
    const bad = row('Bad', '2018-02-02', school.classes.P1B);
    bad.guardians[0]!.phonePrimary = '12345';
    await expect(db.transaction().execute((tx) => target.upsertStudentWithGuardians(bad, tx, USER_IDS.ADMIN))).rejects.toMatchObject({ status: 400 });
  });

  it('StudentLookup returns billing info, active ids and SMS recipients', async () => {
    const info = await lookup.getBillingInfo(first.studentId);
    expect(info).toMatchObject({ studentCode: first.studentCode, fullName: 'Efua Darko', classId: school.classes.P1A, className: 'Primary 1 A', status: 'active' });
    expect(info!.feePayers).toEqual([{ guardianId: first.guardianIds[0], fullName: 'Esther Darko', phone }]);
    expect(await lookup.getBillingInfo('01900000-0000-7000-8000-00000000beef')).toBeNull();
    expect(await lookup.listActiveStudentIds({ classIds: [school.classes.P1A] })).toEqual([first.studentId]);
    expect((await lookup.listActiveStudentIds({ school: true })).length).toBe(2);
    expect(await lookup.listActiveStudentIds({ levelIds: [school.levels.KG1] })).toHaveLength(1);
    expect(await lookup.listActiveStudentIds({})).toEqual([]);
    expect(await lookup.smsRecipients(first.studentId, true)).toEqual([{ guardianId: first.guardianIds[0], phone }]);
  });
});
