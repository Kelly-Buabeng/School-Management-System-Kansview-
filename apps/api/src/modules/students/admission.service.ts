// Owner: Agent B. Admission in one transaction. Used by POST /students and by the import target (same rules).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { SettingsService } from '../settings/settings.service';
import { GuardianWriter } from '../guardians/guardian-writer';
import { admissionYearOf, isPossibleDuplicate, normaliseGuardianFlags, type DuplicateCandidate } from './admission-rules';
import { SafetyWriter } from './safety-writer';
import type { AdmitStudentBody, DuplicateCheckBody } from './students.dto';

export interface AdmitResult {
  studentId: string;
  studentCode: string;
  guardianIds: string[];
  enrolmentId: string;
}

/** Locks the class row and checks capacity. Returns the next roll number. */
export async function reservePlace(tx: Tx, classId: string, opts: { ignoreCapacity?: boolean } = {}): Promise<{ academicYearId: string; rollNumber: number; displayName: string }> {
  const c = await tx.selectFrom('classes').select(['id', 'academic_year_id', 'capacity', 'display_name']).where('id', '=', classId).where('archived_at', 'is', null).forUpdate().executeTakeFirst();
  if (!c) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'The chosen class was not found', undefined, [{ field: 'classId', code: 'NOT_FOUND', message: 'Choose a class' }]);
  const agg = await tx.selectFrom('enrolments').select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(max(roll_number), 0)::int`.as('max_roll')])
    .where('class_id', '=', classId).where('end_date', 'is', null).executeTakeFirstOrThrow();
  if (!opts.ignoreCapacity && c.capacity !== null && agg.n >= c.capacity) {
    throw new AppError(422, ErrorCodes.CLASS_AT_CAPACITY, `${c.display_name} is full`, `It already has ${agg.n} of ${c.capacity} places filled. Choose another class or raise its capacity.`, undefined, { capacity: c.capacity, enrolled: agg.n });
  }
  return { academicYearId: c.academic_year_id, rollNumber: agg.max_roll + 1, displayName: c.display_name };
}

@Injectable()
export class AdmissionService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly guardians: GuardianWriter,
    private readonly safety: SafetyWriter,
  ) {}

  /** Similar name (trigram ≥ threshold) AND same date of birth AND at least one shared guardian phone. */
  async findDuplicates(input: DuplicateCheckBody, tx?: Tx): Promise<DuplicateCandidate[]> {
    const db = tx ?? this.db;
    const threshold = await this.settings.getPolicy('students.duplicate_similarity_threshold', tx);
    const phones = new Set(input.guardianPhones);
    if (input.guardianIds.length) {
      const gs = await db.selectFrom('guardians').select(['phone_primary', 'phone_secondary', 'whatsapp_number']).where('id', 'in', input.guardianIds).execute();
      for (const g of gs) for (const p of [g.phone_primary, g.phone_secondary, g.whatsapp_number]) if (p) phones.add(p);
    }
    const full = [input.firstName, input.middleNames, input.lastName].filter(Boolean).join(' ').toLowerCase();
    const short = `${input.firstName} ${input.lastName}`.toLowerCase();
    const rows = await sql<{ id: string; student_code: string; full_name: string; date_of_birth: string; status: string; class_name: string | null; sim: number; shared: string[] }>`
      SELECT s.id, s.student_code, concat_ws(' ', s.first_name, nullif(s.middle_names, ''), s.last_name) AS full_name,
             s.date_of_birth::text AS date_of_birth, s.status::text AS status, c.display_name AS class_name,
             greatest(similarity(lower(s.first_name || ' ' || coalesce(s.middle_names || ' ', '') || s.last_name), ${full}),
                      similarity(lower(s.first_name || ' ' || s.last_name), ${short}))::float8 AS sim,
             coalesce((SELECT array_agg(DISTINCT p) FROM app.student_guardians sg JOIN app.guardians g ON g.id = sg.guardian_id
                        CROSS JOIN LATERAL unnest(ARRAY[g.phone_primary, g.phone_secondary, g.whatsapp_number]) AS p
                       WHERE sg.student_id = s.id AND p = ANY(${[...phones]}::text[])), '{}') AS shared
        FROM app.students s
        LEFT JOIN app.enrolments e ON e.student_id = s.id AND e.end_date IS NULL
        LEFT JOIN app.classes c ON c.id = e.class_id
       WHERE s.archived_at IS NULL AND s.date_of_birth = ${input.dateOfBirth}::date`.execute(db);
    return rows.rows
      .filter((r) => isPossibleDuplicate({ similarity: r.sim, sameDob: true, sharedPhones: r.shared }, threshold))
      .map((r) => ({ studentId: r.id, studentCode: r.student_code, fullName: r.full_name, dateOfBirth: r.date_of_birth, similarity: Math.round(r.sim * 100) / 100, sharedPhones: r.shared, className: r.class_name, status: r.status === 'graduated' ? 'alumni' : r.status }));
  }

  /** Admits a student. `tx` given → runs inside the caller's transaction (import); otherwise opens one. */
  async admit(body: AdmitStudentBody, actor: AuthUser | { id: string }, opts: { tx?: Tx; source?: 'admission' | 'import'; legacyNote?: string } = {}): Promise<AdmitResult> {
    const run = async (tx: Tx) => this.admitInTx(tx, body, actor, opts.source ?? 'admission', opts.legacyNote);
    return opts.tx ? run(opts.tx) : this.db.transaction().execute(run);
  }

  private async admitInTx(tx: Tx, body: AdmitStudentBody, actor: AuthUser | { id: string }, source: 'admission' | 'import', legacyNote?: string): Promise<AdmitResult> {
    const links = normaliseGuardianFlags(body.guardians);
    const existingIds = links.map((l) => l.guardianId).filter((x): x is string => !!x);
    if (new Set(existingIds).size !== existingIds.length) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'The same guardian is listed twice');
    for (const id of existingIds) await this.guardians.assertExists(tx, id);

    // Duplicate check (similar name + same DOB + shared guardian phone) unless explicitly overridden with a reason.
    const overriding = body.confirmNotDuplicate === true;
    if (overriding && !body.duplicateOverrideReason?.trim()) {
      throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Say why this is not a duplicate', undefined, [{ field: 'duplicateOverrideReason', code: 'REQUIRED', message: 'Give a short reason' }]);
    }
    const newPhones = links.flatMap((l) => (l.newGuardian ? [l.newGuardian.phonePrimary, l.newGuardian.phoneSecondary, l.newGuardian.whatsappNumber] : [])).filter((p): p is string => !!p);
    const candidates = await this.findDuplicates({ firstName: body.firstName, middleNames: body.middleNames, lastName: body.lastName, dateOfBirth: body.dateOfBirth, guardianPhones: newPhones, guardianIds: existingIds }, tx);
    if (candidates.length && !overriding) {
      throw new AppError(409, ErrorCodes.STUDENT_POSSIBLE_DUPLICATE, 'This child may already be registered',
        `${candidates.map((c) => `${c.fullName} (${c.studentCode})`).join(', ')} has the same date of birth, a similar name and a shared parent phone number. Open the existing record, or confirm this is a different child and give a reason.`,
        undefined, { candidates, canOverride: true });
    }

    const place = await reservePlace(tx, body.classId);
    const year = admissionYearOf(body.admissionDate);
    const code = (await sql<{ code: string }>`SELECT app.next_student_code(${year}::int) AS code`.execute(tx)).rows[0]!.code;
    const seq = Number(code.slice(7, 12));

    const student = await tx.insertInto('students').values({
      student_code: code, admission_year: year, admission_seq: seq, first_name: body.firstName, middle_names: body.middleNames ?? null,
      last_name: body.lastName, preferred_name: body.preferredName ?? null, date_of_birth: body.dateOfBirth, gender: body.gender,
      nationality: body.nationality ?? 'Ghanaian', home_address: body.homeAddress ?? null, previous_school: body.previousSchool ?? null,
      admission_date: body.admissionDate, admission_class_id: body.classId, birth_cert_no: body.birthCertNo ?? null, religion: body.religion ?? null,
      languages: body.languages ?? [], status: 'active', created_by: actor.id, updated_by: actor.id,
    }).returning('id').executeTakeFirstOrThrow();

    const guardianIds: string[] = [];
    for (const l of links) {
      const gid = l.guardianId ?? (await this.guardians.create(tx, l.newGuardian!, actor.id));
      guardianIds.push(gid);
      await this.guardians.link(tx, student.id, gid, l, actor.id);
    }

    if (body.medical) await this.safety.upsertMedical(tx, student.id, body.medical, actor.id);

    // Emergency contacts: as given, or the guardians in order (main contact first).
    const contacts = body.emergencyContacts?.length
      ? body.emergencyContacts
      : links.map((l, i) => ({ guardianId: guardianIds[i]!, relationship: l.relationship, priority: l.isPrimary ? 1 : i + 2 }));
    await this.safety.replaceContacts(tx, student.id, contacts, actor.id);

    const enrolment = await tx.insertInto('enrolments').values({
      student_id: student.id, class_id: body.classId, academic_year_id: place.academicYearId, roll_number: place.rollNumber,
      start_date: body.admissionDate, status: 'active', reason: source === 'import' ? 'Imported' : 'Admission', created_by: actor.id, updated_by: actor.id,
    }).returning('id').executeTakeFirstOrThrow();

    await tx.insertInto('student_status_history').values({
      student_id: student.id, from_status: null, to_status: 'active', effective_date: body.admissionDate,
      reason: legacyNote ?? (overriding ? `Admitted; not a duplicate: ${body.duplicateOverrideReason}` : 'Admitted'), source, source_ref_id: enrolment.id, created_by: actor.id,
    }).execute();

    const user = 'roles' in actor ? actor : null;
    await this.audit.record({
      action: 'create', entityType: 'student', entityId: student.id, studentId: student.id,
      changes: { studentCode: { after: code }, classId: { after: body.classId }, guardianIds: { after: guardianIds }, source: { after: source } },
      reason: overriding ? body.duplicateOverrideReason ?? null : null,
    }, user, tx);
    if (overriding && candidates.length) {
      await this.audit.record({
        action: 'update', entityType: 'student_duplicate_override', entityId: student.id, studentId: student.id,
        changes: { candidates: { after: candidates.map((c) => c.studentCode) } }, reason: body.duplicateOverrideReason ?? null,
      }, user, tx);
    }
    return { studentId: student.id, studentCode: code, guardianIds, enrolmentId: enrolment.id };
  }
}
