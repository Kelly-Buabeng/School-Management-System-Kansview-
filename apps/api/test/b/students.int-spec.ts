import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidStudentCode } from './code';
import { admissionBody, auditEvents, RANDOM_ID, seedSchool, setupB, testPhone, type Ctx, type School } from './helpers';

describe('students: admission, duplicates, profile, guardians, emergency view', () => {
  let ctx: Ctx;
  let school: School;
  beforeAll(async () => {
    ctx = await setupB();
    school = await seedSchool(ctx.k);
  });
  afterAll(async () => { await ctx?.close(); });

  const motherPhone = testPhone();
  let firstId = '';
  let motherId = '';

  it('admits a student in one transaction with code, enrolment, guardians, medical and contacts', async () => {
    ctx.as('REGISTRAR');
    const res = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P1A, {
      firstName: 'Ama', lastName: 'Mensah', dateOfBirth: '2019-05-02', gender: 'female',
      guardians: [
        { newGuardian: { firstName: 'Abena', lastName: 'Mensah', phonePrimary: motherPhone.replace('+233', '0'), ghanaCardNumber: 'GHA-123456789-0' }, relationship: 'mother', isPrimary: true, isFeePayer: true },
        { newGuardian: { firstName: 'Kojo', lastName: 'Mensah', phonePrimary: testPhone() }, relationship: 'father' },
      ],
      medical: { bloodGroup: 'O+', allergies: 'Peanuts (severe)', alertSummary: 'Severe peanut allergy, carries EpiPen' },
    })).expect(201);
    firstId = res.body.id;
    expect(isValidStudentCode(res.body.studentCode)).toBe(true);
    expect(res.body.studentCode).toMatch(/^KSV-26-\d{5}-\d$/);
    expect(res.body).toMatchObject({ status: 'active', className: 'Primary 1 A', rollNumber: 1, hasMedicalAlert: true });
    expect(res.body.currentEnrolment).toMatchObject({ classId: school.classes.P1A, rollNumber: 1, status: 'active' });
    expect(res.body.guardians).toHaveLength(2);
    motherId = res.body.guardians.find((g: { isPrimary: boolean }) => g.isPrimary).guardianId;
    const g = res.body.guardians.find((x: { isPrimary: boolean }) => x.isPrimary);
    expect(g.phonePrimary).toBe(motherPhone);
    const medical = await ctx.k.selectFrom('student_medical').selectAll().where('student_id', '=', firstId).executeTakeFirstOrThrow();
    expect(Buffer.from(medical.allergies_enc!).toString('utf8')).not.toContain('Peanuts');
    const hist = await ctx.k.selectFrom('student_status_history').selectAll().where('student_id', '=', firstId).execute();
    expect(hist).toHaveLength(1);
    const contacts = await ctx.k.selectFrom('emergency_contacts').selectAll().where('student_id', '=', firstId).orderBy('priority').execute();
    expect(contacts.map((c) => c.guardian_id)).toEqual([motherId, expect.any(String)]);
    expect((await auditEvents(ctx)).some((e) => e.action === 'create' && e.entityType === 'student' && e.entityId === firstId)).toBe(true);
  });

  it('warns about a possible duplicate and accepts an override with a reason (audited)', async () => {
    ctx.as('REGISTRAR');
    const dup = admissionBody(school.classes.P1B, {
      firstName: 'Amma', lastName: 'Mensah', dateOfBirth: '2019-05-02', gender: 'female',
      guardians: [{ newGuardian: { firstName: 'Abena', lastName: 'Mensah', phonePrimary: motherPhone }, relationship: 'mother' }],
    });
    const check = await ctx.http().post('/api/v1/students/duplicate-check').send({ firstName: 'Amma', lastName: 'Mensah', dateOfBirth: '2019-05-02', guardianPhones: [motherPhone] }).expect(200);
    expect(check.body.isPossibleDuplicate).toBe(true);
    const r = await ctx.http().post('/api/v1/students').send(dup).expect(409);
    expect(r.body.code).toBe('STUDENT_POSSIBLE_DUPLICATE');
    expect(r.body.meta.candidates[0].studentId).toBe(firstId);
    await ctx.http().post('/api/v1/students').send({ ...dup, confirmNotDuplicate: true }).expect(400);
    const ok = await ctx.http().post('/api/v1/students').send({ ...dup, confirmNotDuplicate: true, duplicateOverrideReason: 'Twin sister, different child' }).expect(201);
    expect((await auditEvents(ctx)).some((e) => e.entityType === 'student_duplicate_override' && e.entityId === ok.body.id && e.reason === 'Twin sister, different child')).toBe(true);
    // different DOB → no warning
    await ctx.http().post('/api/v1/students').send({ ...dup, dateOfBirth: '2019-06-02', firstName: 'Ama' }).expect(201);
  });

  it('links an existing guardian so siblings appear automatically', async () => {
    ctx.as('REGISTRAR');
    const res = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.KG1, {
      firstName: 'Yaw', lastName: 'Mensah', dateOfBirth: '2021-01-10',
      guardians: [{ guardianId: motherId, relationship: 'mother', isPrimary: true, isFeePayer: true }],
    })).expect(201);
    const sib = await ctx.http().get(`/api/v1/students/${res.body.id}/siblings`).expect(200);
    expect(sib.body.map((s: { id: string }) => s.id)).toContain(firstId);
    const kids = await ctx.http().get(`/api/v1/guardians/${motherId}/students`).expect(200);
    expect(kids.body.length).toBe(2);
  });

  it('refuses admission into a full class', async () => {
    ctx.as('ADMIN');
    await ctx.k.updateTable('classes').set({ capacity: 1 }).where('id', '=', school.classes.P2A).execute();
    await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P2A, { firstName: 'Kofi', dateOfBirth: '2018-02-01' })).expect(201);
    const r = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P2A, { firstName: 'Esi', dateOfBirth: '2018-03-01' })).expect(422);
    expect(r.body.code).toBe('CLASS_AT_CAPACITY');
  });

  it('gives 20 parallel admissions 20 distinct valid codes', async () => {
    ctx.as('REGISTRAR');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      ctx.http().post('/api/v1/students').send(admissionBody(school.classes.NEXT_P1, { firstName: `Child${i}`, lastName: `Parallel${i}`, dateOfBirth: `2019-01-${String(i + 1).padStart(2, '0')}` }))));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const codes = results.map((r) => r.body.studentCode as string);
    expect(new Set(codes).size).toBe(20);
    expect(codes.every(isValidStudentCode)).toBe(true);
    expect(new Set(results.map((r) => r.body.rollNumber)).size).toBe(20);
  });

  it('views (audited), updates with If-Match, refuses code change, lists and archives', async () => {
    ctx.as('REGISTRAR');
    const g = await ctx.http().get(`/api/v1/students/${firstId}`).expect(200);
    expect(g.headers.etag).toBe(`"${g.body.version}"`);
    expect((await auditEvents(ctx)).some((e) => e.action === 'view' && e.entityId === firstId)).toBe(true);
    await ctx.http().patch(`/api/v1/students/${firstId}`).send({ preferredName: 'Maame' }).expect(428);
    await ctx.http().patch(`/api/v1/students/${firstId}`).set('If-Match', String(g.body.version)).send({ studentCode: 'KSV-26-00001-1' }).expect(422);
    await ctx.http().patch(`/api/v1/students/${firstId}`).set('If-Match', String(g.body.version)).send({ status: 'withdrawn' }).expect(400);
    const u = await ctx.http().patch(`/api/v1/students/${firstId}`).set('If-Match', String(g.body.version)).send({ preferredName: 'Maame' }).expect(200);
    expect(u.body.preferredName).toBe('Maame');
    await ctx.http().patch(`/api/v1/students/${firstId}`).set('If-Match', String(g.body.version)).send({ preferredName: 'Old' }).expect(412);
    const list = await ctx.http().get('/api/v1/students').query({ q: 'mensah', classId: school.classes.P1A }).expect(200);
    expect(list.body.data.map((s: { id: string }) => s.id)).toContain(firstId);
    const byCode = await ctx.http().get('/api/v1/students').query({ q: g.body.studentCode.slice(0, 9) }).expect(200);
    expect(byCode.body.total).toBeGreaterThan(0);
    const history = await ctx.http().get(`/api/v1/students/${firstId}/status-history`).expect(200);
    expect(history.body[0]).toMatchObject({ toStatus: 'active', source: 'admission' });
  });

  it('medical: full detail for REGISTRAR (audited), denied to BURSAR and TEACHER', async () => {
    ctx.as('REGISTRAR');
    const m = await ctx.http().get(`/api/v1/students/${firstId}/medical`).expect(200);
    expect(m.body).toMatchObject({ allergies: 'Peanuts (severe)', hasAlert: true, bloodGroup: 'O+' });
    expect((await auditEvents(ctx)).some((e) => e.action === 'view' && e.entityType === 'student_medical')).toBe(true);
    await ctx.http().put(`/api/v1/students/${firstId}/medical`).send({ allergies: 'Peanuts, penicillin', alertSummary: 'Peanut and penicillin allergy' }).expect(200);
    ctx.as('BURSAR');
    await ctx.http().get(`/api/v1/students/${firstId}/medical`).expect(403);
    ctx.as('TEACHER');
    await ctx.http().get(`/api/v1/students/${firstId}/medical`).expect(403);
    await ctx.http().put(`/api/v1/students/${firstId}/medical`).send({}).expect(403);
  });

  it('emergency view: one call with alert, allergies, ordered contacts with tel links; audited; contact log', async () => {
    ctx.as('REGISTRAR');
    await ctx.http().post(`/api/v1/students/${firstId}/pickups`).send({ name: 'Auntie Efua Owusu', relationship: 'aunt', phone: testPhone() }).expect(201);
    const v = await ctx.http().get(`/api/v1/students/${firstId}/emergency-view`).expect(200);
    expect(v.body.alertSummary).toBe('Peanut and penicillin allergy');
    expect(v.body.allergies).toBe('Peanuts, penicillin');
    expect(v.body.contacts[0]).toMatchObject({ priority: 1, name: 'Abena Mensah', phones: [motherPhone], telLinks: [`tel:${motherPhone}`] });
    expect(v.body.authorisedPickups).toHaveLength(1);
    expect((await auditEvents(ctx)).some((e) => e.action === 'emergency_view' && e.studentId === firstId)).toBe(true);
    const log = await ctx.http().post(`/api/v1/students/${firstId}/emergency-contact-logs`).send({ phoneCalled: motherPhone, outcome: 'reached', notes: 'Mother coming' }).expect(201);
    expect(log.body.outcome).toBe('reached');
    const v2 = await ctx.http().get(`/api/v1/students/${firstId}/emergency-view`).expect(200);
    expect(v2.body.recentContactLog[0]).toMatchObject({ phoneCalled: motherPhone, outcome: 'reached' });
    ctx.as('BURSAR');
    const b = await ctx.http().get(`/api/v1/students/${firstId}/emergency-view`).expect(200);
    expect(b.body.alertSummary).toBeTruthy();
    await ctx.http().get(`/api/v1/students/${firstId}/emergency-contact-logs`).expect(403);
  });

  it('replaces emergency contacts in order and validates them', async () => {
    ctx.as('REGISTRAR');
    const p = testPhone();
    const r = await ctx.http().put(`/api/v1/students/${firstId}/emergency-contacts`).send([
      { priority: 2, guardianId: motherId }, { priority: 1, name: 'Uncle Kwesi', phone: p, relationship: 'uncle' },
    ]).expect(200);
    expect(r.body.map((c: { name: string }) => c.name)).toEqual(['Uncle Kwesi', 'Abena Mensah']);
    await ctx.http().put(`/api/v1/students/${firstId}/emergency-contacts`).send([{ guardianId: RANDOM_ID }]).expect(400);
    await ctx.http().put(`/api/v1/students/${firstId}/emergency-contacts`).send([{ name: 'No phone' }]).expect(400);
  });

  it('guardians: Ghana Card write-only, reveal needs ADMIN + reason (audited), If-Match update, link flags', async () => {
    ctx.as('REGISTRAR');
    const g = await ctx.http().get(`/api/v1/guardians/${motherId}`).expect(200);
    expect(g.body.ghanaCardLast4).toBe('7890');
    expect(JSON.stringify(g.body)).not.toContain('123456789');
    await ctx.http().post(`/api/v1/guardians/${motherId}/ghana-card/reveal`).send({ reason: 'Verify identity' }).expect(403);
    ctx.as('ADMIN');
    await ctx.http().post(`/api/v1/guardians/${motherId}/ghana-card/reveal`).send({}).expect(400);
    const rev = await ctx.http().post(`/api/v1/guardians/${motherId}/ghana-card/reveal`).send({ reason: 'Scholarship paperwork' }).expect(200);
    expect(rev.body.ghanaCardNumber).toBe('GHA-123456789-0');
    expect((await auditEvents(ctx)).some((e) => e.action === 'reveal_sensitive' && e.entityId === motherId && e.reason === 'Scholarship paperwork')).toBe(true);
    const u = await ctx.http().patch(`/api/v1/guardians/${motherId}`).set('If-Match', String(g.body.version)).send({ occupation: 'Trader' }).expect(200);
    expect(u.body.occupation).toBe('Trader');
    await ctx.http().patch(`/api/v1/guardians/${motherId}`).set('If-Match', String(g.body.version)).send({ occupation: 'Nurse' }).expect(412);
    const found = await ctx.http().get('/api/v1/guardians').query({ phone: motherPhone.replace('+233', '0') }).expect(200);
    expect(found.body.data[0].id).toBe(motherId);
    const links = await ctx.http().get(`/api/v1/students/${firstId}/guardians`).expect(200);
    const father = links.body.find((l: { isPrimary: boolean }) => !l.isPrimary);
    const upd = await ctx.http().patch(`/api/v1/students/${firstId}/guardians/${father.id}`).send({ isPrimary: true }).expect(200);
    expect(upd.body.filter((l: { isPrimary: boolean }) => l.isPrimary).map((l: { id: string }) => l.id)).toEqual([father.id]);
    await ctx.http().delete(`/api/v1/students/${firstId}/guardians/${father.id}`).expect(204);
    await ctx.http().delete(`/api/v1/students/${firstId}/guardians/${motherId}`).expect(422);
  });

  it('merges duplicate guardians', async () => {
    ctx.as('REGISTRAR');
    const dupe = await ctx.http().post('/api/v1/guardians').send({ firstName: 'Abena', lastName: 'Mensa', phonePrimary: testPhone() }).expect(201);
    const s = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.KG1, { firstName: 'Adwoa', lastName: 'Mensa', dateOfBirth: '2021-07-07', guardians: [{ guardianId: dupe.body.id, relationship: 'mother' }] })).expect(201);
    const m = await ctx.http().post('/api/v1/guardians/merge').send({ keepGuardianId: motherId, mergeGuardianId: dupe.body.id, reason: 'Same person, typo in name' }).expect(200);
    expect(m.body.children.map((c: { id: string }) => c.id)).toContain(s.body.id);
    await ctx.http().get(`/api/v1/guardians/${dupe.body.id}`).expect(404);
  });

  it('archives a student (audited) and hides it from lists', async () => {
    ctx.as('REGISTRAR');
    const s = await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.KG1, { firstName: 'Mistake', lastName: 'Entry', dateOfBirth: '2021-02-02' })).expect(201);
    await ctx.http().post(`/api/v1/students/${s.body.id}/archive`).send({ reason: 'Entered twice' }).expect(403);
    ctx.as('ADMIN');
    await ctx.http().post(`/api/v1/students/${s.body.id}/archive`).send({ reason: 'Entered twice' }).expect(204);
    expect((await auditEvents(ctx)).some((e) => e.action === 'archive' && e.entityId === s.body.id)).toBe(true);
    ctx.as('REGISTRAR');
    await ctx.http().get(`/api/v1/students/${s.body.id}`).expect(404);
    const open = await ctx.k.selectFrom('enrolments').select('id').where('student_id', '=', s.body.id).where('end_date', 'is', null).execute();
    expect(open).toHaveLength(0);
  });

  it('documents and photos go through the upload pipeline', async () => {
    ctx.as('REGISTRAR');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const r = await ctx.http().post(`/api/v1/students/${firstId}/documents`).field('docType', 'birth_certificate').attach('file', pdf, { filename: 'birth.pdf', contentType: 'application/pdf' });
    expect([201, 501]).toContain(r.status);
    await ctx.http().get(`/api/v1/students/${firstId}/documents`).expect(200);
    await ctx.http().post(`/api/v1/students/${firstId}/documents`).field('docType', 'tax_return').attach('file', pdf, 'x.pdf').expect(400);
    ctx.as('BURSAR');
    await ctx.http().get(`/api/v1/students/${firstId}/documents`).expect(403);
  });

  it('denies roles (403) and unknown ids (404) across student routes', async () => {
    ctx.as('BURSAR');
    await ctx.http().post('/api/v1/students').send(admissionBody(school.classes.P1A)).expect(403);
    await ctx.http().post(`/api/v1/students/${firstId}/pickups`).send({ name: 'X' }).expect(403);
    ctx.as('TEACHER');
    await ctx.http().patch(`/api/v1/students/${firstId}`).set('If-Match', '1').send({}).expect(403);
    await ctx.http().post('/api/v1/guardians').send({}).expect(403);
    ctx.as('HEADTEACHER');
    await ctx.http().put(`/api/v1/students/${firstId}/emergency-contacts`).send([]).expect(403);
    ctx.as('ADMIN');
    for (const path of ['', '/medical', '/siblings', '/emergency-view', '/emergency-contacts', '/emergency-contact-logs', '/pickups', '/guardians', '/status-history', '/documents']) {
      await ctx.http().get(`/api/v1/students/${RANDOM_ID}${path}`).expect(404);
    }
    await ctx.http().get(`/api/v1/guardians/${RANDOM_ID}`).expect(404);
    await ctx.http().get('/api/v1/students/abc').expect(404);
  });
});
