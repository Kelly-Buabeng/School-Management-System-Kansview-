import { ageOn, formatCedis } from '@sms/shared';
import type { AttendanceMark, ClearanceItem, PromotionAction } from '@/api/types';
import { balanceOf, currentEnrolment, getDb, summary, uid, type Db, type MClass, type MUser } from '../db';
import { audit, fakePdf, json, noContent, notFound, problem, r, validation } from '../http';
import { findStudent } from './students';

const todayIso = () => new Date().toISOString().slice(0, 10);

function classDto(db: Db, c: MClass) {
  const lvl = db.levels.find((l) => l.id === c.levelId)!;
  return {
    id: c.id,
    name: c.name,
    levelId: c.levelId,
    levelName: lvl.name,
    academicYearId: c.academicYearId,
    capacity: c.capacity,
    enrolledCount: db.enrolments.filter((e) => e.classId === c.id && !e.endDate).length,
    classTeacherName: db.staff.find((s) => s.id === c.classTeacherId)?.fullName ?? null,
    stream: c.stream ?? null,
  };
}

function teacherClassIds(db: Db, user: MUser): Set<string> | null {
  if (!user.roles.every((ro) => ro === 'TEACHER')) return null;
  const staff = db.staff.find((s) => s.id === user.staffId);
  return new Set((staff?.assignments ?? []).map((a) => a.classId));
}

function classInScope(db: Db, user: MUser, id: string) {
  const c = db.classes.find((x) => x.id === id);
  if (!c) return null;
  const own = teacherClassIds(db, user);
  return own && !own.has(c.id) ? null : c;
}

function rollOf(db: Db, classId: string) {
  return db.enrolments
    .filter((e) => e.classId === classId && !e.endDate)
    .map((e) => ({ e, s: db.students.find((s) => s.id === e.studentId)! }))
    .sort((a, b) => a.e.rollNumber - b.e.rollNumber);
}

function nextLevelClass(db: Db, c: MClass, toYearId: string) {
  const lvl = db.levels.find((l) => l.id === c.levelId)!;
  const nextLvl = db.levels.find((l) => l.order === lvl.order + 1);
  if (!nextLvl) return null;
  return db.classes.find((x) => x.academicYearId === toYearId && x.levelId === nextLvl.id && (x.stream ?? null) === null) ?? db.classes.find((x) => x.academicYearId === toYearId && x.levelId === nextLvl.id) ?? null;
}

function runDto(db: Db, run: Db['promotionRuns'][number]) {
  const { classIds, snapshot, ...rest } = run;
  void classIds;
  void snapshot;
  return {
    ...rest,
    items: run.items.map((i) => ({ ...i, targetClassName: db.classes.find((c) => c.id === i.targetClassId)?.name ?? null })),
  };
}

export const schoolHandlers = [
  // ---------- academic setup ----------
  r.get('/academic-years', 'academic_setup:read', () => {
    const db = getDb();
    return json({ data: db.years.map((y) => ({ ...y, terms: db.terms.filter((t) => t.academicYearId === y.id) })) });
  }),
  r.post<{ id: string }>('/academic-years/{id}/set-current', 'academic_setup:update', ({ user, params }) => {
    const db = getDb();
    const y = db.years.find((x) => x.id === params.id);
    if (!y) return notFound('academic year');
    db.years.forEach((x) => (x.isCurrent = x.id === y.id));
    audit(user, 'update', 'academic_year', `Set ${y.name} as the current year`);
    return json(y);
  }),
  r.patch<{ id: string }>('/terms/{id}', 'academic_setup:update', async ({ user, params, body }) => {
    const db = getDb();
    const t = db.terms.find((x) => x.id === params.id);
    if (!t) return notFound('term');
    const b = await body<{ startDate?: string; endDate?: string }>();
    if (b.startDate && b.endDate && b.startDate > b.endDate) return validation([{ field: 'endDate', message: 'The term must end after it starts' }]);
    Object.assign(t, b);
    audit(user, 'update', 'term', `Changed dates of ${t.name}`);
    return json(t);
  }),
  r.get('/levels', 'academic_setup:read', () => json({ data: getDb().levels })),
  r.get('/subjects', 'academic_setup:read', () => json({ data: getDb().subjects })),
  r.get('/grading-scales', 'academic_setup:read', () => json({ data: getDb().gradingScales })),
  r.put<{ id: string }>('/grading-scales/{id}', 'settings:update', async ({ user, params, body }) => {
    const db = getDb();
    const gs = db.gradingScales.find((g) => g.id === params.id);
    if (!gs) return notFound('grading scale');
    const b = await body<Partial<typeof gs>>();
    if ((b.classWeightPercent ?? gs.classWeightPercent) + (b.examWeightPercent ?? gs.examWeightPercent) !== 100) return validation([{ field: 'examWeightPercent', message: 'Class and exam weights must add up to 100' }]);
    Object.assign(gs, b);
    audit(user, 'update', 'grading_scale', 'Changed the grading scale');
    return json(gs);
  }),
  r.get('/classes', 'academic_setup:read', ({ user, query }) => {
    const db = getDb();
    const yearId = query.get('academicYearId') ?? db.years.find((y) => y.isCurrent)!.id;
    const own = teacherClassIds(db, user);
    return json({ data: db.classes.filter((c) => c.academicYearId === yearId && (!own || own.has(c.id))).map((c) => classDto(db, c)) });
  }),
  r.get<{ id: string }>('/classes/{id}', 'academic_setup:read', ({ user, params }) => {
    const db = getDb();
    const c = classInScope(db, user, params.id);
    return c ? json(classDto(db, c)) : notFound('class');
  }),
  r.patch<{ id: string }>('/classes/{id}', 'academic_setup:update', async ({ user, params, body }) => {
    const db = getDb();
    const c = db.classes.find((x) => x.id === params.id);
    if (!c) return notFound('class');
    const b = await body<{ capacity?: number }>();
    if (b.capacity !== undefined) {
      if (!Number.isInteger(b.capacity) || b.capacity < 1) return validation([{ field: 'capacity', message: 'Capacity must be a whole number above 0' }]);
      c.capacity = b.capacity;
    }
    audit(user, 'update', 'class', `Changed ${c.name}`);
    return json(classDto(db, c));
  }),
  r.get<{ id: string }>('/classes/{id}/students', 'enrolments:read', ({ user, params }) => {
    const db = getDb();
    const c = classInScope(db, user, params.id);
    if (!c) return notFound('class');
    return json({ data: rollOf(db, c.id).map(({ s }) => ({ ...summary(db, s), gender: s.gender, dateOfBirth: s.dateOfBirth })) });
  }),

  // ---------- attendance ----------
  r.get<{ id: string }>('/classes/{id}/attendance', 'attendance:read', ({ user, params, query }) => {
    const db = getDb();
    const c = classInScope(db, user, params.id);
    if (!c) return notFound('class');
    const date = query.get('date') ?? todayIso();
    const saved = db.attendance.get(`${c.id}|${date}`);
    return json({
      classId: c.id,
      date,
      taken: Boolean(saved),
      entries: rollOf(db, c.id).map(({ e, s }) => {
        const m = saved?.find((x) => x.studentId === s.id);
        return { studentId: s.id, fullName: summary(db, s).fullName, rollNumber: e.rollNumber, status: m?.status ?? 'present', reason: m?.reason };
      }),
    });
  }),
  r.put<{ id: string }>('/classes/{id}/attendance', 'attendance:update', async ({ user, params, query, body }) => {
    const db = getDb();
    const c = classInScope(db, user, params.id);
    if (!c) return notFound('class');
    const date = query.get('date') ?? todayIso();
    if (date > todayIso()) return validation([{ field: 'date', message: 'You cannot take attendance for a future date' }]);
    const b = await body<{ entries?: { studentId: string; status: AttendanceMark; reason?: string }[] }>();
    db.attendance.set(`${c.id}|${date}`, b.entries ?? []);
    const absent = (b.entries ?? []).filter((e) => e.status === 'absent').length;
    audit(user, 'update', 'attendance', `Saved ${c.name} register for ${date} (${absent} absent)`);
    return json({ saved: true, absentSmsQueued: db.policies.absenceSmsEnabled ? absent : 0 });
  }),
  r.get('/attendance/summary', 'attendance:read', ({ query }) => {
    const db = getDb();
    const classId = query.get('classId');
    const rows = db.classes
      .filter((c) => c.academicYearId === db.years.find((y) => y.isCurrent)!.id && (!classId || c.id === classId))
      .map((c) => {
        let present = 0;
        let absent = 0;
        let late = 0;
        for (const [k, v] of db.attendance) {
          if (!k.startsWith(`${c.id}|`)) continue;
          for (const e of v) e.status === 'absent' ? absent++ : e.status === 'late' ? late++ : present++;
        }
        const total = present + absent + late || 1;
        return { classId: c.id, name: c.name, present, absent, late, ratePercent: Math.round(((present + late) * 100) / total) };
      });
    return json({ data: rows });
  }),

  // ---------- scores & report cards ----------
  r.get<{ id: string }>('/classes/{id}/scores', 'academics:read', ({ user, params, query }) => {
    const db = getDb();
    const c = classInScope(db, user, params.id);
    if (!c) return notFound('class');
    const termId = query.get('termId') ?? '';
    const subjectId = query.get('subjectId') ?? '';
    const saved = db.scores.get(`${c.id}|${termId}|${subjectId}`) ?? [];
    return json({
      classId: c.id,
      termId,
      subjectId,
      locked: db.lockedTerms.has(termId),
      classMax: 30,
      examMax: 70,
      rows: rollOf(db, c.id).map(({ e, s }) => {
        const m = saved.find((x) => x.studentId === s.id);
        return { studentId: s.id, fullName: summary(db, s).fullName, rollNumber: e.rollNumber, classScore: m?.classScore ?? null, examScore: m?.examScore ?? null };
      }),
    });
  }),
  r.put<{ id: string }>('/classes/{id}/scores', 'academics:update', async ({ user, params, query, body }) => {
    const db = getDb();
    const c = classInScope(db, user, params.id);
    if (!c) return notFound('class');
    const termId = query.get('termId') ?? '';
    if (db.lockedTerms.has(termId)) return problem(423, 'SCORES_LOCKED', 'Scores for this term are locked. Ask the headteacher if a change is needed.');
    const b = await body<{ rows?: { studentId: string; classScore: number | null; examScore: number | null }[] }>();
    const bad = (b.rows ?? []).find((x) => (x.classScore ?? 0) > 30 || (x.examScore ?? 0) > 70 || (x.classScore ?? 0) < 0 || (x.examScore ?? 0) < 0);
    if (bad) return validation([{ field: `rows.${bad.studentId}`, message: 'Class score is out of 30 and exam score out of 70' }]);
    db.scores.set(`${c.id}|${termId}|${query.get('subjectId')}`, b.rows ?? []);
    audit(user, 'update', 'scores', `Saved scores for ${c.name}`);
    return json({ saved: true });
  }),
  r.get('/report-cards', 'academics:read', ({ query }) => {
    const db = getDb();
    const termId = query.get('termId');
    const classId = query.get('classId');
    const cls = db.classes.find((c) => c.id === classId);
    return json({ data: db.reportCards.filter((rc) => rc.termId === termId && (!cls || rc.className === cls.name)) });
  }),
  r.patch<{ id: string }>('/report-cards/{id}', 'academics:update', async ({ user, perms, params, body }) => {
    const db = getDb();
    const rc = db.reportCards.find((x) => x.id === params.id);
    if (!rc) return notFound('report card');
    const b = await body<{ teacherRemark?: string; headRemark?: string; conduct?: string; interest?: string }>();
    if (b.headRemark !== undefined && !perms.has('academics:publish')) return problem(403, 'FORBIDDEN', "Only the headteacher can write the head's remark.");
    Object.assign(rc, b);
    audit(user, 'update', 'report_card', `Updated remarks for ${rc.studentName}`);
    return json(rc);
  }),
  r.post('/report-cards/publish', 'academics:publish', async ({ user, body }) => {
    const db = getDb();
    const b = await body<{ ids?: string[] }>();
    const ids = new Set(b.ids ?? []);
    let n = 0;
    for (const rc of db.reportCards) if (ids.has(rc.id) && rc.status === 'draft') { rc.status = 'published'; n++; }
    audit(user, 'update', 'report_card', `Published ${n} report cards`);
    return json({ published: n });
  }),
  r.get<{ id: string }>('/report-cards/{id}/pdf', 'academics:export', ({ params }) => {
    const rc = getDb().reportCards.find((x) => x.id === params.id);
    if (!rc) return notFound('report card');
    return fakePdf(`Report card — ${rc.studentName}`, [`Class: ${rc.className}`, `Average: ${rc.average ?? '—'}`, `Position: ${rc.position ?? '—'}`, `Teacher: ${rc.teacherRemark ?? ''}`, `Head: ${rc.headRemark ?? ''}`]);
  }),
  r.post<{ id: string }>('/terms/{id}/scores/lock', 'academics:publish', ({ user, params }) => {
    getDb().lockedTerms.add(params.id);
    audit(user, 'update', 'term', 'Locked term scores');
    return json({ locked: true });
  }),

  // ---------- promotion ----------
  r.get('/promotion-runs', 'promotion:read', () => {
    const db = getDb();
    return json({ data: db.promotionRuns.map((x) => runDto(db, x)) });
  }),
  r.post('/promotion-runs', 'promotion:create', async ({ user, body }) => {
    const db = getDb();
    const b = await body<{ fromAcademicYearId?: string; toAcademicYearId?: string; classIds?: string[] }>();
    const from = db.years.find((y) => y.id === b.fromAcademicYearId);
    const to = db.years.find((y) => y.id === b.toAcademicYearId);
    if (!from || !to || from.id === to.id) return validation([{ field: 'toAcademicYearId', message: 'Choose a different year to promote into' }]);
    if (!b.classIds?.length) return validation([{ field: 'classIds', message: 'Choose at least one class' }]);
    const policy = db.policies.arrearsPromotionPolicy;
    const items = b.classIds.flatMap((cid) => {
      const c = db.classes.find((x) => x.id === cid);
      if (!c) return [];
      const lvl = db.levels.find((l) => l.id === c.levelId)!;
      const isFinal = !db.levels.some((l) => l.order === lvl.order + 1);
      const target = isFinal ? null : nextLevelClass(db, c, to.id);
      return rollOf(db, c.id).map(({ s }) => {
        const owed = balanceOf(db, s.id);
        return { id: uid(), student: summary(db, s), fromClassName: c.name, action: (isFinal ? 'graduate' : 'promote') as PromotionAction, targetClassId: target?.id ?? null, outstandingPesewas: owed, arrearsFlag: policy !== 'off' && owed > 0, overrideReason: undefined as string | undefined };
      });
    });
    const run = { id: uid(), status: 'draft' as const, fromAcademicYearId: from.id, toAcademicYearId: to.id, arrearsPolicy: policy, undoDeadline: null, createdAt: new Date().toISOString(), items, classIds: b.classIds };
    db.promotionRuns.unshift(run);
    audit(user, 'create', 'promotion_run', `Previewed promotion for ${b.classIds.length} classes`);
    return json(runDto(db, run), 201);
  }),
  r.get<{ id: string }>('/promotion-runs/{id}', 'promotion:read', ({ params }) => {
    const db = getDb();
    const run = db.promotionRuns.find((x) => x.id === params.id);
    return run ? json(runDto(db, run)) : notFound('promotion run');
  }),
  r.patch<{ id: string; itemId: string }>('/promotion-runs/{id}/items/{itemId}', 'promotion:update', async ({ params, body }) => {
    const db = getDb();
    const run = db.promotionRuns.find((x) => x.id === params.id);
    const item = run?.items.find((i) => i.id === params.itemId);
    if (!run || !item) return notFound('promotion item');
    if (run.status !== 'draft') return problem(422, 'PROMOTION_INVALID_STATE', 'This promotion was already committed.');
    const b = await body<{ action?: PromotionAction; targetClassId?: string | null; overrideReason?: string }>();
    if (b.action && b.action !== 'promote' && b.action !== 'graduate' && (b.overrideReason ?? item.overrideReason ?? '').trim().length < 3) {
      return validation([{ field: 'overrideReason', message: 'Give a reason for this exception' }]);
    }
    if (b.action) {
      item.action = b.action;
      if (b.action === 'repeat') {
        const fromCls = db.classes.find((c) => c.name === item.fromClassName && c.academicYearId === run.fromAcademicYearId);
        item.targetClassId = db.classes.find((c) => c.academicYearId === run.toAcademicYearId && c.levelId === fromCls?.levelId)?.id ?? null;
      } else if (b.action === 'skip') {
        const fromCls = db.classes.find((c) => c.name === item.fromClassName && c.academicYearId === run.fromAcademicYearId)!;
        const n1 = nextLevelClass(db, fromCls, run.toAcademicYearId);
        item.targetClassId = n1 ? nextLevelClass(db, { ...n1, academicYearId: run.toAcademicYearId }, run.toAcademicYearId)?.id ?? null : null;
      } else if (b.action === 'promote') {
        const fromCls = db.classes.find((c) => c.name === item.fromClassName && c.academicYearId === run.fromAcademicYearId)!;
        item.targetClassId = nextLevelClass(db, fromCls, run.toAcademicYearId)?.id ?? null;
      } else item.targetClassId = null;
    }
    if (b.targetClassId !== undefined) item.targetClassId = b.targetClassId;
    if (b.overrideReason !== undefined) item.overrideReason = b.overrideReason;
    return json({ ...item, targetClassName: db.classes.find((c) => c.id === item.targetClassId)?.name ?? null });
  }),
  r.post<{ id: string }>(
    '/promotion-runs/{id}/commit',
    'promotion:commit',
    ({ user, params }) => {
      const db = getDb();
      const run = db.promotionRuns.find((x) => x.id === params.id);
      if (!run) return notFound('promotion run');
      if (run.status !== 'draft') return problem(422, 'PROMOTION_INVALID_STATE', 'This promotion was already committed.');
      if (run.arrearsPolicy === 'block') {
        const blocked = run.items.filter((i) => i.arrearsFlag && i.action === 'promote' && !(i.overrideReason ?? '').trim());
        if (blocked.length) return problem(422, 'PROMOTION_BLOCKED_ARREARS', `${blocked.length} student(s) owe fees and need an override reason before promotion.`, { meta: { itemIds: blocked.map((b) => b.id) } });
      }
      run.snapshot = { enrolments: db.enrolments.map((e) => ({ ...e })), statuses: Object.fromEntries(db.students.map((s) => [s.id, s.status])) };
      const toYear = db.years.find((y) => y.id === run.toAcademicYearId)!;
      for (const it of run.items) {
        const en = currentEnrolment(db, it.student.id!);
        if (en) {
          en.endDate = todayIso();
          en.status = 'completed';
        }
        const s = db.students.find((x) => x.id === it.student.id)!;
        if (it.action === 'graduate') s.status = 'alumni';
        else if (it.action === 'withdraw') s.status = 'withdrawn';
        else if (it.action === 'transfer_out') s.status = 'transferred_out';
        else if (it.targetClassId) {
          const roll = db.enrolments.filter((e) => e.classId === it.targetClassId && !e.endDate).length + 1;
          db.enrolments.push({ id: uid(), studentId: s.id, classId: it.targetClassId, rollNumber: roll, startDate: toYear.startDate, endDate: null, status: 'active' });
        }
      }
      run.status = 'committed';
      run.undoDeadline = new Date(Date.now() + db.policies.promotionUndoDays * 86400000).toISOString();
      audit(user, 'update', 'promotion_run', `Committed promotion of ${run.items.length} students`);
      return json(runDto(db, run));
    },
    { idempotent: true },
  ),
  r.post<{ id: string }>('/promotion-runs/{id}/undo', 'promotion:undo', async ({ user, params, body }) => {
    const db = getDb();
    const run = db.promotionRuns.find((x) => x.id === params.id);
    if (!run) return notFound('promotion run');
    if (run.status !== 'committed' || !run.snapshot) return problem(422, 'PROMOTION_INVALID_STATE', 'Only a committed promotion can be undone.');
    if (run.undoDeadline && run.undoDeadline < new Date().toISOString()) return problem(422, 'PROMOTION_UNDO_WINDOW_CLOSED', 'The time allowed to undo this promotion has passed.');
    const { reason } = await body<{ reason?: string }>();
    if ((reason ?? '').trim().length < 5) return validation([{ field: 'reason', message: 'Give a reason (at least 5 characters)' }]);
    db.enrolments = run.snapshot.enrolments;
    for (const s of db.students) if (run.snapshot.statuses[s.id]) s.status = run.snapshot.statuses[s.id]!;
    run.status = 'undone';
    audit(user, 'update', 'promotion_run', `Undid promotion: ${reason}`);
    return json(runDto(db, run));
  }),

  // ---------- withdrawals ----------
  r.get('/withdrawals', 'withdrawals:read', () => json({ data: getDb().withdrawals })),
  r.get<{ id: string }>('/withdrawals/{id}', 'withdrawals:read', ({ params }) => {
    const w = getDb().withdrawals.find((x) => x.id === params.id);
    return w ? json(w) : notFound('withdrawal');
  }),
  r.post<{ id: string }>('/students/{id}/withdrawals', 'withdrawals:create', async ({ user, params, body }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    const b = await body<{ reason?: string; kind?: 'withdrawal' | 'transfer_out'; destinationSchool?: string }>();
    if ((b.reason ?? '').trim().length < 3) return validation([{ field: 'reason', message: 'Give the reason for leaving' }]);
    const w = { id: uid(), student: summary(db, s), reason: b.reason!, kind: b.kind ?? 'withdrawal', destinationSchool: b.destinationSchool, status: 'pending_clearance' as const, balancePesewas: balanceOf(db, s.id), clearance: { fees: { cleared: false }, books: { cleared: false }, uniform: { cleared: false }, property: { cleared: false }, library: { cleared: false } }, startedAt: new Date().toISOString() };
    db.withdrawals.unshift(w);
    audit(user, 'create', 'withdrawal', `Started withdrawal for ${s.studentCode}`, s.id);
    return json(w, 201);
  }),
  r.put<{ id: string; item: string }>('/withdrawals/{id}/clearance/{item}', 'withdrawals:update', async ({ user, params, body }) => {
    const db = getDb();
    const w = db.withdrawals.find((x) => x.id === params.id);
    if (!w) return notFound('withdrawal');
    const item = params.item as ClearanceItem;
    if (item === 'fees' && !user.roles.some((ro) => ro === 'BURSAR' || ro === 'ADMIN')) return problem(403, 'FORBIDDEN', 'Only the bursar or administrator can clear fees.');
    const b = await body<{ cleared?: boolean; note?: string }>();
    w.clearance[item] = { cleared: Boolean(b.cleared), by: user.fullName, at: new Date().toISOString(), note: b.note };
    audit(user, 'update', 'withdrawal', `Clearance "${item}" ${b.cleared ? 'cleared' : 'reopened'} for ${w.student.fullName}`);
    return json(w);
  }),
  r.post<{ id: string }>('/withdrawals/{id}/complete', 'withdrawals:complete', ({ user, params }) => {
    const db = getDb();
    const w = db.withdrawals.find((x) => x.id === params.id);
    if (!w) return notFound('withdrawal');
    const pending = Object.entries(w.clearance).filter(([, v]) => !v.cleared).map(([k]) => k);
    if (pending.length) return problem(422, 'WITHDRAWAL_NOT_CLEARED', `Still to clear: ${pending.join(', ')}.`);
    w.status = 'completed';
    const s = db.students.find((x) => x.id === w.student.id)!;
    s.status = w.kind === 'transfer_out' ? 'transferred_out' : 'withdrawn';
    const en = currentEnrolment(db, s.id);
    if (en) { en.endDate = todayIso(); en.status = 'withdrawn'; }
    audit(user, 'update', 'withdrawal', `Completed withdrawal of ${w.student.fullName}`);
    return json(w);
  }),
  r.post<{ id: string }>('/withdrawals/{id}/cancel', 'withdrawals:update', ({ user, params }) => {
    const w = getDb().withdrawals.find((x) => x.id === params.id);
    if (!w) return notFound('withdrawal');
    w.status = 'cancelled';
    audit(user, 'update', 'withdrawal', `Cancelled withdrawal of ${w.student.fullName}`);
    return json(w);
  }),
  r.get<{ id: string }>('/withdrawals/{id}/transfer-letter.pdf', 'withdrawals:export', ({ params }) => {
    const db = getDb();
    const w = db.withdrawals.find((x) => x.id === params.id);
    if (!w) return notFound('withdrawal');
    return fakePdf('Transfer letter', [`This is to certify that ${w.student.fullName} (${w.student.studentCode})`, `was a pupil of ${db.school.name}.`, `Destination: ${w.destinationSchool ?? '—'}`]);
  }),

  // ---------- staff ----------
  r.get('/staff', 'staff:read', ({ user }) => {
    const db = getDb();
    const full = user.roles.includes('ADMIN');
    return json({ data: db.staff.map((s) => (full ? s : { id: s.id, fullName: s.fullName, jobTitle: s.jobTitle, phone: user.roles.includes('BURSAR') ? undefined : s.phone, status: s.status })) });
  }),
  r.post('/staff', 'staff:create', async ({ user, body }) => {
    const b = await body<{ fullName?: string; jobTitle?: string; phone?: string }>();
    if (!b.fullName?.trim()) return validation([{ field: 'fullName', message: 'Enter the name' }]);
    const s = { id: uid(), fullName: b.fullName.trim(), jobTitle: b.jobTitle ?? '', phone: b.phone, status: 'active' as const, assignments: [] };
    getDb().staff.push(s);
    audit(user, 'create', 'staff', `Added staff ${s.fullName}`);
    return json(s, 201);
  }),
  r.post<{ id: string }>('/staff/{id}/sensitive/reveal', 'staff_sensitive:reveal', async ({ user, params, body }) => {
    const s = getDb().staff.find((x) => x.id === params.id);
    if (!s) return notFound('staff member');
    const { reason } = await body<{ reason?: string }>();
    if ((reason ?? '').trim().length < 5) return validation([{ field: 'reason', message: 'Give a reason (at least 5 characters). This is recorded.' }]);
    audit(user, 'reveal_sensitive', 'staff', `Revealed Ghana Card/SSNIT of ${s.fullName}. Reason: ${reason}`);
    return json({ ghanaCardNumber: `GHA-71${s.id.slice(-7)}-3`.replace(/[a-f]/g, '0'), ssnitNumber: `C01${s.id.slice(-10)}`.replace(/[a-f]/g, '0') });
  }),

  // ---------- settings ----------
  r.get('/settings/school', 'settings:read', () => json(getDb().school)),
  r.patch('/settings/school', 'settings:update', async ({ user, body }) => {
    const db = getDb();
    const b = await body<Partial<Db['school']>>();
    if (b.schoolCode && b.schoolCode !== db.school.schoolCode) return problem(422, 'STUDENT_CODE_IMMUTABLE', 'The school code is locked after the first student is admitted.');
    Object.assign(db.school, b, { version: (db.school.version ?? 1) + 1 });
    audit(user, 'update', 'settings', 'Changed the school profile');
    return json(db.school);
  }),
  r.get('/settings/policies', 'settings:read', () => json(getDb().policies)),
  r.patch('/settings/policies', 'settings:update', async ({ user, body }) => {
    const db = getDb();
    Object.assign(db.policies, await body(), { version: (db.policies.version ?? 1) + 1 });
    audit(user, 'update', 'settings', 'Changed school policies');
    return json(db.policies);
  }),

  // ---------- dashboard ----------
  r.get('/dashboard', 'dashboard:read', ({ user, perms }) => {
    const db = getDb();
    const roles = user.roles;
    const all = roles.includes('ADMIN') || roles.includes('HEADTEACHER');
    const finance = all || roles.includes('BURSAR');
    const enrol = all || roles.includes('REGISTRAR');
    const own = teacherClassIds(db, user);
    const cur = db.years.find((y) => y.isCurrent)!;
    const term = db.terms.find((t) => t.isCurrent)!;
    const widgets: string[] = [];
    const out: Record<string, unknown> = {};
    if (enrol) {
      widgets.push('enrolmentByClass', 'birthdays');
      out.enrolmentByClass = db.classes.filter((c) => c.academicYearId === cur.id).map((c) => ({ className: c.name, count: classDto(db, c).enrolledCount, capacity: c.capacity }));
      const now = new Date();
      out.birthdays = db.students
        .filter((s) => s.status === 'active')
        .map((s) => {
          const [, m, d] = s.dateOfBirth.split('-').map(Number) as [number, number, number];
          let next = new Date(Date.UTC(now.getUTCFullYear(), m - 1, d));
          if (next.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) next = new Date(Date.UTC(now.getUTCFullYear() + 1, m - 1, d));
          return { s, next };
        })
        .filter(({ next }) => next.getTime() - now.getTime() < 14 * 86400000)
        .sort((a, b) => a.next.getTime() - b.next.getTime())
        .map(({ s, next }) => ({ studentId: s.id, fullName: summary(db, s).fullName, className: summary(db, s).className ?? '', date: next.toISOString().slice(0, 10), turning: ageOn(s.dateOfBirth, next.toISOString().slice(0, 10)) }));
    }
    if (finance && perms.has('balances:read')) {
      widgets.push('collection', 'arrears', 'todayPayments');
      const billed = db.ledger.filter((l) => l.entryType === 'charge').reduce((a, l) => a + l.amountPesewas, 0);
      const paid = db.payments.filter((p) => p.status === 'confirmed').reduce((a, p) => a + p.amountPesewas, 0);
      out.collection = { termName: `${cur.name} ${term.name}`, collectedPesewas: paid, targetPesewas: billed };
      const owing = db.students.map((s) => ({ s, b: balanceOf(db, s.id) })).filter((x) => x.b > 0);
      const byClass = new Map<string, number>();
      for (const o of owing) {
        const cn = summary(db, o.s).className ?? '—';
        byClass.set(cn, (byClass.get(cn) ?? 0) + o.b);
      }
      out.arrears = { totalPesewas: owing.reduce((a, o) => a + o.b, 0), studentCount: owing.length, topClasses: [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([className, outstandingPesewas]) => ({ className, outstandingPesewas })) };
      const todays = db.payments.filter((p) => p.receivedAt.slice(0, 10) === todayIso() && p.status === 'confirmed');
      out.todayPayments = { count: todays.length, totalPesewas: todays.reduce((a, p) => a + p.amountPesewas, 0) };
    }
    if (all || own) {
      widgets.push('attendanceTrend');
      const byDate = new Map<string, { p: number; t: number }>();
      for (const [k, v] of db.attendance) {
        const [cid, date] = k.split('|') as [string, string];
        if (own && !own.has(cid)) continue;
        const agg = byDate.get(date) ?? { p: 0, t: 0 };
        agg.t += v.length;
        agg.p += v.filter((e) => e.status !== 'absent').length;
        byDate.set(date, agg);
      }
      out.attendanceTrend = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-10).map(([date, a]) => ({ date, ratePercent: Math.round((a.p * 100) / (a.t || 1)) }));
    }
    return json({ widgets, ...out });
  }),
];

export { noContent, formatCedis };
