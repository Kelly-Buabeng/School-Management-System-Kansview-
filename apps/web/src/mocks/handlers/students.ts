import { normaliseGhanaPhone } from '@sms/shared';
import { formatStudentCode } from '@sms/shared';
import type { DuplicateCandidate } from '@/api/types';
import { avatar, balanceOf, currentEnrolment, getDb, summary, uid, type Db, type MGuardian, type MStudent, type MUser } from '../db';
import { audit, json, noContent, notFound, paginate, problem, r, validation } from '../http';

const FULL_ADDRESS_ROLES = ['ADMIN', 'HEADTEACHER', 'REGISTRAR'];

/** TEACHER sees only students in classes they are assigned to; everyone else sees all. */
export function studentInScope(db: Db, user: MUser, studentId: string) {
  if (!user.roles.every((ro) => ro === 'TEACHER')) return true;
  const staff = db.staff.find((s) => s.id === user.staffId);
  const classIds = new Set((staff?.assignments ?? []).map((a) => a.classId));
  const en = currentEnrolment(db, studentId);
  return Boolean(en && classIds.has(en.classId));
}

export function findStudent(db: Db, user: MUser, id: string) {
  const s = db.students.find((x) => x.id === id && !x.archived);
  if (!s || !studentInScope(db, user, s.id)) return null;
  return s;
}

function studentDto(db: Db, s: MStudent, user: MUser, perms: Set<string>) {
  const en = currentEnrolment(db, s.id);
  const cls = en ? db.classes.find((c) => c.id === en.classId) : undefined;
  const year = cls ? db.years.find((y) => y.id === cls.academicYearId) : undefined;
  const showAddress = user.roles.some((ro) => FULL_ADDRESS_ROLES.includes(ro));
  return {
    ...summary(db, s),
    firstName: s.firstName,
    middleNames: s.middleNames,
    lastName: s.lastName,
    dateOfBirth: s.dateOfBirth,
    gender: s.gender,
    nationality: s.nationality,
    homeAddress: showAddress ? s.homeAddress : undefined,
    previousSchool: s.previousSchool,
    admissionDate: s.admissionDate,
    admissionClassId: s.admissionClassId,
    classId: cls?.id,
    levelId: cls?.levelId,
    currentEnrolment: en && cls ? { id: en.id, classId: cls.id, className: cls.name, academicYear: year?.name, rollNumber: en.rollNumber, startDate: en.startDate, endDate: en.endDate, status: en.status } : undefined,
    birthCertNo: s.birthCertNo,
    religion: s.religion,
    languages: s.languages,
    balancePesewas: perms.has('balances:read') ? balanceOf(db, s.id) : undefined,
    version: s.version,
  };
}

export function guardianDto(db: Db, g: MGuardian, user: MUser) {
  const showAddress = user.roles.some((ro) => FULL_ADDRESS_ROLES.includes(ro));
  const children = db.links.filter((l) => l.guardianId === g.id).map((l) => db.students.find((s) => s.id === l.studentId)!).filter((s) => s && !s.archived);
  return {
    id: g.id,
    fullName: [g.title, g.firstName, g.lastName].filter(Boolean).join(' '),
    phonePrimary: g.phonePrimary,
    phoneSecondary: g.phoneSecondary,
    whatsappNumber: g.whatsappNumber,
    email: g.email,
    occupation: g.occupation,
    workplace: g.workplace,
    homeAddress: showAddress ? g.homeAddress : undefined,
    workAddress: showAddress ? g.workAddress : undefined,
    ghanaCardLast4: g.ghanaCard ? g.ghanaCard.slice(-6, -2).replace('-', '') : undefined,
    children: children.map((s) => summary(db, s)),
    version: g.version,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function findDuplicates(db: Db, input: { firstName?: string; lastName?: string; dateOfBirth?: string; guardianPhones?: string[] }): DuplicateCandidate[] {
  const phones = new Set((input.guardianPhones ?? []).map((p) => normaliseGhanaPhone(p)).filter(Boolean) as string[]);
  const out: DuplicateCandidate[] = [];
  for (const s of db.students) {
    if (s.archived) continue;
    const reasons: string[] = [];
    const sameName = norm(s.firstName) === norm(input.firstName ?? '') && norm(s.lastName) === norm(input.lastName ?? '');
    const sameDob = s.dateOfBirth === input.dateOfBirth;
    const gPhones = db.links.filter((l) => l.studentId === s.id).map((l) => db.guardians.find((g) => g.id === l.guardianId)!.phonePrimary);
    const samePhone = gPhones.some((p) => phones.has(p));
    if (sameName) reasons.push('Same name');
    if (sameDob) reasons.push('Same date of birth');
    if (samePhone && sameName) reasons.push('Same guardian phone');
    if ((sameName && sameDob) || (sameName && samePhone)) {
      out.push({ id: s.id, studentCode: s.studentCode, fullName: `${s.firstName} ${s.lastName}`, dateOfBirth: s.dateOfBirth, className: summary(db, s).className, guardianPhone: gPhones[0], matchReasons: reasons });
    }
  }
  return out;
}

interface AdmitBody {
  firstName?: string;
  middleNames?: string;
  lastName?: string;
  preferredName?: string;
  dateOfBirth?: string;
  gender?: 'male' | 'female';
  homeAddress?: string;
  previousSchool?: string;
  admissionDate?: string;
  classId?: string;
  birthCertNo?: string;
  religion?: string;
  languages?: string[];
  nationality?: string;
  guardians?: { guardianId?: string; newGuardian?: Partial<MGuardian> & { ghanaCardNumber?: string }; relationship?: string; isPrimary?: boolean; isFeePayer?: boolean; canPickUp?: boolean }[];
  medical?: Record<string, string>;
  emergencyContacts?: { priority?: number; guardianId?: string; name?: string; relationship?: string; phone?: string; notes?: string }[];
  confirmNotDuplicate?: boolean;
  duplicateOverrideReason?: string;
}

export const studentHandlers = [
  r.get('/students', 'students:read', ({ user, query }) => {
    const db = getDb();
    const q = (query.get('q') ?? '').toLowerCase().trim();
    const classId = query.get('classId');
    const levelId = query.get('levelId');
    const status = query.get('status');
    let list = db.students.filter((s) => !s.archived && studentInScope(db, user, s.id));
    if (status) list = list.filter((s) => s.status === status);
    if (classId) list = list.filter((s) => currentEnrolment(db, s.id)?.classId === classId);
    if (levelId) list = list.filter((s) => db.classes.find((c) => c.id === currentEnrolment(db, s.id)?.classId)?.levelId === levelId);
    if (q) list = list.filter((s) => `${s.firstName} ${s.middleNames ?? ''} ${s.lastName} ${s.studentCode}`.toLowerCase().includes(q));
    list.sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
    return json(paginate(list.map((s) => summary(db, s)), query));
  }),

  r.post('/students/duplicate-check', 'students:create', async ({ body }) => json({ data: findDuplicates(getDb(), await body()) })),

  r.post('/students', 'students:create', async ({ user, body }) => {
    const db = getDb();
    const b = await body<AdmitBody>();
    const errors: { field: string; message: string }[] = [];
    if (!b.firstName?.trim()) errors.push({ field: 'firstName', message: 'Enter the first name' });
    if (!b.lastName?.trim()) errors.push({ field: 'lastName', message: 'Enter the surname' });
    if (!b.dateOfBirth) errors.push({ field: 'dateOfBirth', message: 'Enter the date of birth' });
    if (!b.classId) errors.push({ field: 'classId', message: 'Choose a class' });
    if (!b.guardians?.length) errors.push({ field: 'guardians', message: 'Add at least one parent or guardian' });
    if (errors.length) return validation(errors);
    const cls = db.classes.find((c) => c.id === b.classId);
    if (!cls) return validation([{ field: 'classId', message: 'Choose a class' }]);
    const enrolled = db.enrolments.filter((e) => e.classId === cls.id && !e.endDate).length;
    if (enrolled >= cls.capacity) return problem(422, 'CLASS_AT_CAPACITY', `${cls.name} is full (${enrolled} of ${cls.capacity}).`, { detail: 'Choose another class or ask the administrator to raise the capacity.' });

    const phones = (b.guardians ?? []).map((g) => (g.guardianId ? db.guardians.find((x) => x.id === g.guardianId)?.phonePrimary : g.newGuardian?.phonePrimary)).filter(Boolean) as string[];
    const dups = findDuplicates(db, { firstName: b.firstName, lastName: b.lastName, dateOfBirth: b.dateOfBirth, guardianPhones: phones });
    if (dups.length && !b.confirmNotDuplicate) {
      return problem(409, 'STUDENT_POSSIBLE_DUPLICATE', 'This child may already be registered.', {
        detail: `We found ${dups.length} possible match${dups.length > 1 ? 'es' : ''}. Check before admitting again.`,
        meta: { candidates: dups },
      });
    }
    if (dups.length && (b.duplicateOverrideReason ?? '').trim().length < 5) {
      return validation([{ field: 'duplicateOverrideReason', message: 'Explain why this is a different child (at least 5 characters)' }]);
    }
    for (const [i, g] of (b.guardians ?? []).entries()) {
      if (g.newGuardian) {
        const phone = normaliseGhanaPhone(g.newGuardian.phonePrimary ?? '');
        if (!phone) return validation([{ field: `guardians.${i}.newGuardian.phonePrimary`, message: 'Enter a valid Ghana phone number, e.g. 024 000 0123' }]);
        if (g.newGuardian.ghanaCardNumber && !/^GHA-\d{9}-\d$/.test(g.newGuardian.ghanaCardNumber)) {
          return validation([{ field: `guardians.${i}.newGuardian.ghanaCardNumber`, message: 'Ghana Card format is GHA-123456789-0' }]);
        }
      }
    }

    const year = Number((b.admissionDate ?? '2026').slice(0, 4));
    db.counters.studentSeq[year] = (db.counters.studentSeq[year] ?? 0) + 1;
    const s: MStudent = {
      id: uid(),
      studentCode: formatStudentCode('KSV', year, db.counters.studentSeq[year]!),
      firstName: b.firstName!.trim(),
      middleNames: b.middleNames?.trim() || undefined,
      lastName: b.lastName!.trim(),
      preferredName: b.preferredName?.trim() || undefined,
      dateOfBirth: b.dateOfBirth!,
      gender: b.gender ?? 'male',
      status: 'active',
      nationality: b.nationality ?? 'Ghanaian',
      homeAddress: b.homeAddress ?? '',
      previousSchool: b.previousSchool,
      admissionDate: b.admissionDate ?? new Date().toISOString().slice(0, 10),
      admissionClassId: cls.id,
      religion: b.religion,
      languages: b.languages ?? [],
      birthCertNo: b.birthCertNo,
      photoUrl: avatar(`${b.firstName} ${b.lastName}`, db.students.length),
      medical: b.medical && Object.values(b.medical).some(Boolean) ? { ...b.medical, updatedAt: new Date().toISOString() } : null,
      emergencyContacts: [],
      version: 1,
      archived: false,
    };
    db.students.push(s);
    db.enrolments.push({ id: uid(), studentId: s.id, classId: cls.id, rollNumber: enrolled + 1, startDate: s.admissionDate, endDate: null, status: 'active' });
    for (const g of b.guardians ?? []) {
      let guardian = g.guardianId ? db.guardians.find((x) => x.id === g.guardianId) : undefined;
      if (!guardian && g.newGuardian) {
        guardian = {
          id: uid(),
          title: g.newGuardian.title,
          firstName: g.newGuardian.firstName ?? '',
          lastName: g.newGuardian.lastName ?? '',
          phonePrimary: normaliseGhanaPhone(g.newGuardian.phonePrimary ?? '')!,
          phoneSecondary: g.newGuardian.phoneSecondary ? normaliseGhanaPhone(g.newGuardian.phoneSecondary) ?? undefined : undefined,
          email: g.newGuardian.email,
          occupation: g.newGuardian.occupation,
          homeAddress: g.newGuardian.homeAddress,
          ghanaCard: g.newGuardian.ghanaCardNumber,
          version: 1,
        };
        db.guardians.push(guardian);
      }
      if (!guardian) continue;
      db.links.push({ studentId: s.id, guardianId: guardian.id, relationship: g.relationship ?? 'Guardian', isPrimary: Boolean(g.isPrimary), isFeePayer: Boolean(g.isFeePayer), canPickUp: g.canPickUp ?? true, receivesSms: Boolean(g.isPrimary) });
    }
    s.emergencyContacts = (b.emergencyContacts ?? []).map((c, i) => ({
      priority: c.priority ?? i + 1,
      guardianId: c.guardianId,
      name: c.name ?? '',
      relationship: c.relationship ?? '',
      phone: normaliseGhanaPhone(c.phone ?? '') ?? c.phone ?? '',
      notes: c.notes,
    }));
    audit(user, 'create', 'student', `Admitted ${s.firstName} ${s.lastName} (${s.studentCode}) into ${cls.name}${b.confirmNotDuplicate ? ` — duplicate warning overridden: ${b.duplicateOverrideReason}` : ''}`, s.id);
    return json(studentDto(db, s, user, new Set(['balances:read'])), 201);
  }),

  r.get<{ id: string }>('/students/{id}', 'students:read', ({ user, perms, params }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    audit(user, 'view', 'student', `Viewed ${s.firstName} ${s.lastName}`, s.id);
    return json(studentDto(db, s, user, perms));
  }),

  r.patch<{ id: string }>('/students/{id}', 'students:update', async ({ user, perms, params, request, body }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    const ifMatch = request.headers.get('If-Match');
    if (!ifMatch) return problem(428, 'PRECONDITION_REQUIRED', 'Reload the record and try again.');
    if (Number(ifMatch) !== s.version) return problem(412, 'VERSION_CONFLICT', 'Someone else changed this record while you were editing. Reload to see their changes.');
    const b = await body<Partial<MStudent>>();
    if ('studentCode' in b) return problem(422, 'STUDENT_CODE_IMMUTABLE', 'The student ID can never be changed.');
    for (const k of ['firstName', 'middleNames', 'lastName', 'preferredName', 'homeAddress', 'previousSchool', 'religion', 'birthCertNo'] as const) {
      if (k in b) (s as unknown as Record<string, unknown>)[k] = b[k];
    }
    s.version += 1;
    audit(user, 'update', 'student', `Updated ${s.firstName} ${s.lastName}`, s.id);
    return json(studentDto(db, s, user, perms));
  }),

  r.get<{ id: string }>('/students/{id}/medical', 'medical:read', ({ user, params }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    audit(user, 'view', 'medical', `Viewed medical record of ${s.firstName} ${s.lastName}`, s.id);
    return json({ ...(s.medical ?? {}), hasAlert: Boolean(s.medical?.alertSummary) });
  }),

  r.put<{ id: string }>('/students/{id}/medical', 'medical:update', async ({ user, params, body }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    s.medical = { ...(await body<Record<string, string>>()), updatedAt: new Date().toISOString() };
    audit(user, 'update', 'medical', `Updated medical record of ${s.firstName} ${s.lastName}`, s.id);
    return json({ ...s.medical, hasAlert: Boolean(s.medical.alertSummary) });
  }),

  r.get<{ id: string }>('/students/{id}/documents', 'student_documents:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    return json({ data: db.documents.filter((d) => d.studentId === params.id) });
  }),

  r.post<{ id: string }>('/students/{id}/documents', 'student_documents:create', async ({ user, params, request }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return validation([{ field: 'file', message: 'Choose a file' }]);
    if (file.size > 5 * 1024 * 1024) return problem(413, 'FILE_TOO_LARGE', 'That file is bigger than 5 MB.');
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) return problem(415, 'FILE_TYPE_NOT_ALLOWED', 'Only PDF, JPEG or PNG files can be uploaded.');
    const doc = { id: uid(), studentId: s.id, docType: String(form.get('docType') ?? 'other') as 'other', fileName: file.name, uploadedAt: new Date().toISOString(), scanStatus: 'pending' as const, notes: String(form.get('notes') ?? '') || undefined };
    db.documents.push(doc);
    setTimeout(() => {
      (doc as { scanStatus: string }).scanStatus = 'clean';
    }, 3000);
    audit(user, 'create', 'student_document', `Uploaded ${doc.docType} for ${s.firstName} ${s.lastName}`, s.id);
    return json(doc, 201);
  }),

  r.get<{ id: string }>('/students/{id}/guardians', 'guardians:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    return json({
      data: db.links
        .filter((l) => l.studentId === params.id)
        .map((l) => ({ guardian: guardianDto(db, db.guardians.find((g) => g.id === l.guardianId)!, user), relationship: l.relationship, isPrimary: l.isPrimary, isFeePayer: l.isFeePayer, canPickUp: l.canPickUp, receivesSms: l.receivesSms })),
    });
  }),

  r.get<{ id: string }>('/students/{id}/siblings', 'students:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    const gids = new Set(db.links.filter((l) => l.studentId === params.id).map((l) => l.guardianId));
    const sibIds = new Set(db.links.filter((l) => gids.has(l.guardianId) && l.studentId !== params.id).map((l) => l.studentId));
    return json({ data: db.students.filter((s) => sibIds.has(s.id) && !s.archived).map((s) => summary(db, s)) });
  }),

  r.get<{ id: string }>('/students/{id}/enrolments', 'enrolments:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    return json({
      data: db.enrolments
        .filter((e) => e.studentId === params.id)
        .map((e) => {
          const c = db.classes.find((x) => x.id === e.classId)!;
          return { id: e.id, classId: c.id, className: c.name, academicYear: db.years.find((y) => y.id === c.academicYearId)?.name, rollNumber: e.rollNumber, startDate: e.startDate, endDate: e.endDate, status: e.status };
        })
        .sort((a, b) => b.startDate.localeCompare(a.startDate)),
    });
  }),

  r.get<{ id: string }>('/students/{id}/status-history', 'students:read', ({ user, params }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    return json({ data: [{ status: 'active', from: s.admissionDate, reason: 'Admitted' }] });
  }),

  r.get<{ id: string }>('/students/{id}/incidents', 'incidents:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    const own = user.roles.every((ro) => ro === 'TEACHER');
    return json({ data: db.incidents.filter((i) => i.studentId === params.id && (!own || i.recordedBy === user.fullName)) });
  }),

  r.post<{ id: string }>('/students/{id}/incidents', 'incidents:create', async ({ user, params, body }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    const b = await body<{ occurredOn?: string; category?: string; description?: string; actionTaken?: string }>();
    if (!b.description?.trim()) return validation([{ field: 'description', message: 'Describe what happened' }]);
    const inc = { id: uid(), studentId: params.id, occurredOn: b.occurredOn ?? new Date().toISOString().slice(0, 10), category: b.category ?? 'General', description: b.description, actionTaken: b.actionTaken, recordedBy: user.fullName };
    db.incidents.push(inc);
    audit(user, 'create', 'incident', 'Recorded an incident', params.id);
    return json(inc, 201);
  }),

  // ---------- emergency ----------
  r.get<{ id: string }>('/students/{id}/emergency-view', 'emergency_view:read', ({ user, params }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    audit(user, 'emergency_view', 'student', `Opened Emergency View for ${s.firstName} ${s.lastName}`, s.id);
    const contacts = [...s.emergencyContacts]
      .sort((a, b) => a.priority - b.priority)
      .map((c) => {
        const g = c.guardianId ? db.guardians.find((x) => x.id === c.guardianId) : undefined;
        const phones = [c.phone, g?.phoneSecondary].filter(Boolean) as string[];
        return { priority: c.priority, name: c.name, relationship: c.relationship, phones, telLinks: phones.map((p) => `tel:${p}`) };
      });
    return json({
      student: summary(db, s),
      bloodGroup: s.medical?.bloodGroup,
      alertSummary: s.medical?.alertSummary,
      allergies: s.medical?.allergies,
      contacts,
      authorisedPickups: db.pickups.filter((p) => p.studentId === s.id && !p.archived).map(({ id, name, relationship, phone, photoUrl, notes }) => ({ id, name, relationship, phone, photoUrl, notes })),
      doctor: s.medical?.doctorName ? { name: s.medical.doctorName, clinic: s.medical.clinicName, phone: s.medical.clinicPhone } : undefined,
      recentContactLog: db.contactLogs.filter((l) => l.studentId === s.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5),
    });
  }),

  r.get<{ id: string }>('/students/{id}/emergency-contacts', 'students:read', ({ user, params }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    return json({ data: s.emergencyContacts });
  }),

  r.put<{ id: string }>('/students/{id}/emergency-contacts', 'students:update', async ({ user, params, body }) => {
    const db = getDb();
    const s = findStudent(db, user, params.id);
    if (!s) return notFound('student');
    const b = await body<{ contacts: MStudent['emergencyContacts'] }>();
    s.emergencyContacts = (b.contacts ?? []).map((c, i) => ({ ...c, priority: i + 1, phone: normaliseGhanaPhone(c.phone) ?? c.phone }));
    audit(user, 'update', 'student', 'Updated emergency contacts', s.id);
    return json({ data: s.emergencyContacts });
  }),

  r.get<{ id: string }>('/students/{id}/emergency-contact-logs', 'emergency_log:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    return json({ data: db.contactLogs.filter((l) => l.studentId === params.id).sort((a, b) => b.at.localeCompare(a.at)) });
  }),

  r.post<{ id: string }>('/students/{id}/emergency-contact-logs', 'emergency_log:create', async ({ user, params, body }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    const b = await body<{ contactName?: string; phone?: string; outcome?: string; notes?: string }>();
    if (!['reached', 'no_answer', 'wrong_number', 'message_left'].includes(b.outcome ?? '')) return validation([{ field: 'outcome', message: 'Choose what happened on the call' }]);
    const log = { id: uid(), studentId: params.id, at: new Date().toISOString(), byName: user.fullName, contactName: b.contactName ?? '', phone: b.phone ?? '', outcome: b.outcome as 'reached', notes: b.notes };
    db.contactLogs.push(log);
    audit(user, 'create', 'emergency_log', `Logged call to ${log.contactName}: ${log.outcome}`, params.id);
    return json(log, 201);
  }),

  r.get<{ id: string }>('/students/{id}/pickups', 'pickups:read', ({ user, params }) => {
    const db = getDb();
    if (!findStudent(db, user, params.id)) return notFound('student');
    return json({ data: db.pickups.filter((p) => p.studentId === params.id && !p.archived) });
  }),

  // ---------- guardians ----------
  r.get('/guardians', 'guardians:read', ({ user, query }) => {
    const db = getDb();
    const q = (query.get('q') ?? '').toLowerCase().trim();
    const phone = normaliseGhanaPhone(query.get('phone') ?? '') ?? (query.get('phone') ?? '').replace(/\s/g, '');
    let list = db.guardians;
    if (q) list = list.filter((g) => `${g.firstName} ${g.lastName}`.toLowerCase().includes(q) || g.phonePrimary.includes(q.replace(/\s/g, '').replace(/^0/, '')));
    if (phone) list = list.filter((g) => g.phonePrimary.includes(phone.replace(/^0/, '')) || g.phonePrimary === phone);
    return json(paginate(list.map((g) => guardianDto(db, g, user)), query));
  }),

  r.get<{ guardianId: string }>('/guardians/{guardianId}', 'guardians:read', ({ user, params }) => {
    const db = getDb();
    const g = db.guardians.find((x) => x.id === params.guardianId);
    if (!g) return notFound('parent or guardian');
    audit(user, 'view', 'guardian', `Viewed guardian ${g.firstName} ${g.lastName}`, g.id);
    return json(guardianDto(db, g, user));
  }),

  r.get<{ guardianId: string }>('/guardians/{guardianId}/students', 'guardians:read', ({ params }) => {
    const db = getDb();
    const ids = db.links.filter((l) => l.guardianId === params.guardianId);
    return json({ data: ids.map((l) => ({ ...summary(db, db.students.find((s) => s.id === l.studentId)!), relationship: l.relationship, isFeePayer: l.isFeePayer })) });
  }),

  r.post<{ guardianId: string }>('/guardians/{guardianId}/ghana-card/reveal', 'ghana_card:reveal', async ({ user, params, body }) => {
    const db = getDb();
    const g = db.guardians.find((x) => x.id === params.guardianId);
    if (!g) return notFound('parent or guardian');
    const { reason } = await body<{ reason?: string }>();
    if ((reason ?? '').trim().length < 5) return validation([{ field: 'reason', message: 'Give a reason (at least 5 characters). This is recorded.' }]);
    audit(user, 'reveal_sensitive', 'guardian', `Revealed Ghana Card of ${g.firstName} ${g.lastName}. Reason: ${reason}`, g.id);
    return json({ ghanaCardNumber: g.ghanaCard ?? null });
  }),

  r.get<{ guardianId: string }>('/guardians/{guardianId}/balance', 'balances:read', ({ params }) => {
    const db = getDb();
    const links = db.links.filter((l) => l.guardianId === params.guardianId && l.isFeePayer);
    const children = links.map((l) => {
      const s = db.students.find((x) => x.id === l.studentId)!;
      const sm = summary(db, s);
      return { studentId: s.id, fullName: sm.fullName, studentCode: s.studentCode, className: sm.className, balancePesewas: balanceOf(db, s.id) };
    });
    return json({ guardianId: params.guardianId, totalPesewas: children.reduce((a, c) => a + c.balancePesewas, 0), children });
  }),

  // ---------- search ----------
  r.get('/search', 'search:read', ({ user, perms, query }) => {
    const db = getDb();
    const q = (query.get('q') ?? '').toLowerCase().trim();
    const limit = Math.min(20, Number(query.get('limit') ?? 10));
    if (q.length < 2) return validation([{ field: 'q', message: 'Type at least 2 letters' }]);
    const digits = q.replace(/\D/g, '');
    const students = db.students
      .filter((s) => !s.archived && studentInScope(db, user, s.id))
      .filter((s) => {
        const cls = summary(db, s).className ?? '';
        return `${s.firstName} ${s.middleNames ?? ''} ${s.lastName} ${s.studentCode} ${cls}`.toLowerCase().includes(q);
      })
      .slice(0, limit)
      .map((s) => {
        const sm = summary(db, s);
        return perms.has('medical:read') || perms.has('emergency_view:read') ? sm : { ...sm, hasMedicalAlert: undefined };
      });
    const teacherOnly = user.roles.every((ro) => ro === 'TEACHER');
    const guardians = teacherOnly
      ? []
      : db.guardians
          .filter((g) => `${g.firstName} ${g.lastName}`.toLowerCase().includes(q) || (digits.length >= 4 && g.phonePrimary.includes(digits.replace(/^0/, ''))))
          .slice(0, limit)
          .map((g) => ({ id: g.id, fullName: `${g.firstName} ${g.lastName}`, phone: g.phonePrimary, childrenCount: db.links.filter((l) => l.guardianId === g.id).length }));
    const staff = perms.has('staff:read') ? db.staff.filter((s) => s.fullName.toLowerCase().includes(q)).slice(0, limit).map((s) => ({ id: s.id, fullName: s.fullName, jobTitle: s.jobTitle })) : [];
    const receipts = perms.has('payments:read')
      ? db.payments
          .filter((p) => p.receiptNo.toLowerCase().includes(q))
          .slice(0, limit)
          .map((p) => ({ paymentId: p.id, receiptNo: p.receiptNo, studentName: summary(db, db.students.find((s) => s.id === p.studentId)!).fullName, amountPesewas: p.amountPesewas }))
      : [];
    return json({ students, guardians, staff, receipts });
  }),
];

export { noContent };
