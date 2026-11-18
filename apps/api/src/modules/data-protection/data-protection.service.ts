import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import type { Page } from '../../common/pagination';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_CRYPTO, type FieldCrypto } from '../../security/field-crypto';

export const ListDsrQuery = z.strictObject({
  status: z.enum(['received', 'in_progress', 'completed', 'rejected']).optional(),
  type: z.enum(['access', 'correction', 'deletion', 'objection']).optional(),
  studentId: z.string().uuid().optional(),
  overdue: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const CreateDsrBody = z.strictObject({
  requesterName: z.string().trim().min(2).max(120),
  relationship: z.string().trim().max(60).optional(),
  studentId: z.string().uuid().optional(),
  guardianId: z.string().uuid().optional(),
  type: z.enum(['access', 'correction', 'deletion', 'objection']),
  receivedAt: z.string().datetime({ offset: true }).optional(),
}).refine((b) => b.studentId || b.guardianId, { message: 'Choose the student or guardian the request is about', path: ['studentId'] });

export const UpdateDsrBody = z.strictObject({
  status: z.enum(['received', 'in_progress', 'completed', 'rejected']).optional(),
  outcome: z.string().trim().max(2000).optional(),
  responseFileId: z.string().uuid().nullable().optional(),
});

export const AnonymiseBody = z.strictObject({
  /** Typed confirmation: the user must type the student code exactly. */
  confirmStudentCode: z.string().trim().min(1).max(20),
  reason: z.string().trim().min(5).max(500),
});

export const RetentionQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const LEFT_STATUSES = ['withdrawn', 'transferred_out', 'graduated', 'deceased'] as const;
const ANON = '[anonymised]';

export interface DsrDto {
  id: string;
  requesterName: string;
  relationship: string | null;
  studentId: string | null;
  guardianId: string | null;
  type: string;
  receivedAt: string;
  dueAt: string;
  status: string;
  overdue: boolean;
  handledBy: string | null;
  outcome: string | null;
  responseFileId: string | null;
  version: number;
}

type DsrRow = {
  id: string; requester_name: string; relationship: string | null; student_id: string | null; guardian_id: string | null; type: string;
  received_at: Date | string; due_at: Date | string; status: string; handled_by: string | null; outcome: string | null; response_file_id: string | null; version: number;
};
const DSR_COLS = ['id', 'requester_name', 'relationship', 'student_id', 'guardian_id', 'type', 'received_at', 'due_at', 'status', 'handled_by', 'outcome', 'response_file_id', 'version'] as const;

function toDsr(r: DsrRow): DsrDto {
  const due = new Date(r.due_at);
  return {
    id: r.id, requesterName: r.requester_name, relationship: r.relationship, studentId: r.student_id, guardianId: r.guardian_id, type: r.type,
    receivedAt: new Date(r.received_at).toISOString(), dueAt: due.toISOString(), status: r.status,
    overdue: (r.status === 'received' || r.status === 'in_progress') && due.getTime() < Date.now(),
    handledBy: r.handled_by, outcome: r.outcome, responseFileId: r.response_file_id, version: r.version,
  };
}

@Injectable()
export class DataProtectionService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto,
  ) {}

  // ---------------- data subject requests ----------------

  async list(q: z.infer<typeof ListDsrQuery>): Promise<Page<DsrDto>> {
    let base = this.db.selectFrom('data_subject_requests');
    if (q.status) base = base.where('status', '=', q.status);
    if (q.type) base = base.where('type', '=', q.type);
    if (q.studentId) base = base.where('student_id', '=', q.studentId);
    if (q.overdue === 'true') base = base.where('due_at', '<', new Date()).where('status', 'in', ['received', 'in_progress']);
    const [rows, total] = await Promise.all([
      base.select(DSR_COLS).orderBy('due_at').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    return { data: rows.map(toDsr), page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) };
  }

  async create(b: z.infer<typeof CreateDsrBody>, actor: AuthUser): Promise<DsrDto> {
    return this.db.transaction().execute(async (tx) => {
      if (b.studentId && !(await tx.selectFrom('students').select('id').where('id', '=', b.studentId).executeTakeFirst())) throw AppError.notFound('student');
      if (b.guardianId && !(await tx.selectFrom('guardians').select('id').where('id', '=', b.guardianId).executeTakeFirst())) throw AppError.notFound('guardian');
      const row = await tx.insertInto('data_subject_requests').values({
        requester_name: b.requesterName, relationship: b.relationship ?? null, student_id: b.studentId ?? null, guardian_id: b.guardianId ?? null,
        type: b.type, ...(b.receivedAt ? { received_at: new Date(b.receivedAt) } : {}),
        due_at: sql<Date>`NULL`, created_by: actor.id, updated_by: actor.id,
      }).returning(DSR_COLS).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'data_subject_request', entityId: row.id, studentId: row.student_id, changes: { type: { after: row.type } } }, actor, tx);
      return toDsr(row);
    });
  }

  async update(id: string, b: z.infer<typeof UpdateDsrBody>, actor: AuthUser): Promise<DsrDto> {
    return this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('data_subject_requests').select(DSR_COLS).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('request');
      const row = await tx.updateTable('data_subject_requests').set({
        ...(b.status ? { status: b.status } : {}),
        ...(b.outcome !== undefined ? { outcome: b.outcome } : {}),
        ...(b.responseFileId !== undefined ? { response_file_id: b.responseFileId } : {}),
        handled_by: actor.id, updated_by: actor.id, updated_at: new Date(), version: sql`version + 1`,
      }).where('id', '=', id).returning(DSR_COLS).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'update', entityType: 'data_subject_request', entityId: id, studentId: row.student_id,
        changes: { status: { before: before.status, after: row.status } }, reason: b.outcome ?? null }, actor, tx);
      return toDsr(row);
    });
  }

  // ---------------- subject access export ----------------

  /**
   * Gathers everything held about one student as JSON (subject access request).
   * STUB of the export job: runs synchronously and returns the pack in the 202 body. When the export queue
   * (Agent F) exists, this becomes a job whose file is downloaded from /exports/{id}; the gathering code stays.
   */
  async subjectAccessExport(studentId: string, actor: AuthUser): Promise<{ status: 'completed'; generatedAt: string; data: Record<string, unknown> }> {
    const student = await this.db.selectFrom('students').selectAll().where('id', '=', studentId).executeTakeFirst();
    if (!student) throw AppError.notFound('student');
    const { search_vector: _sv, ...studentData } = student as typeof student & { search_vector?: unknown };
    const dec = (b: Buffer | null) => (b ? this.crypto.decrypt(b) : null);
    const med = await this.db.selectFrom('student_medical').selectAll().where('student_id', '=', studentId).executeTakeFirst();
    const byStudent = <T extends Parameters<Db['selectFrom']>[0]>(table: T) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.db.selectFrom(table as any).selectAll() as any).where('student_id', '=', studentId).execute() as Promise<Record<string, unknown>[]>;
    const guardians = await this.db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .select(['g.id', 'g.title', 'g.first_name', 'g.last_name', 'g.phone_primary', 'g.phone_secondary', 'g.whatsapp_number', 'g.email', 'g.occupation', 'g.workplace',
        'g.home_address', 'g.work_address', 'sg.relationship', 'sg.is_primary', 'sg.is_fee_payer', 'sg.can_pick_up', 'sg.lives_with_student', 'sg.receives_sms'])
      .where('sg.student_id', '=', studentId).execute();
    const [enrolments, statusHistory, attendance, scores, reportCards, incidents, healthVisits, contacts, pickups, contactLogs, documents, invoices, payments, adjustments, ledger] = await Promise.all([
      byStudent('enrolments'), byStudent('student_status_history'), byStudent('attendance_records'), byStudent('term_scores'), byStudent('report_cards'),
      byStudent('incidents'), byStudent('health_visits'), byStudent('emergency_contacts'), byStudent('authorised_pickups'), byStudent('emergency_contact_logs'),
      this.db.selectFrom('student_documents as d').innerJoin('files as f', 'f.id', 'd.file_id').select(['d.id', 'd.doc_type', 'd.notes', 'd.created_at', 'f.original_name', 'f.mime_type', 'f.size_bytes'])
        .where('d.student_id', '=', studentId).execute(),
      byStudent('invoices'), byStudent('payments'), byStudent('adjustments'), byStudent('ledger_entries'),
    ]);
    const accessLog = await this.db.selectFrom('audit.events as e').leftJoin('users as u', 'u.id', 'e.actor_user_id')
      .select(['e.occurred_at', 'e.action', 'e.entity_type', 'u.full_name as actor', 'e.actor_role']).where('e.student_id', '=', studentId).orderBy('e.id').execute();
    const data = {
      notice: 'Personal data held by the school about this student (Data Protection Act, 2012 (Act 843) subject access request).',
      student: studentData,
      medical: med ? {
        bloodGroup: med.blood_group, allergies: dec(med.allergies_enc), chronicConditions: dec(med.chronic_conditions_enc), medicationNotes: dec(med.medication_notes_enc),
        specialNeeds: dec(med.special_needs_enc), doctorName: med.doctor_name, clinicName: med.clinic_name, clinicPhone: med.clinic_phone, alertSummary: med.alert_summary,
      } : null,
      guardians, enrolments, statusHistory, attendance, scores, reportCards, incidents, healthVisits,
      emergencyContacts: contacts, authorisedPickups: pickups, emergencyContactLogs: contactLogs, documents,
      finance: { invoices, payments, adjustments, ledger, balancePesewas: ledger.reduce((s, e) => s + Number(e.amount_pesewas ?? 0), 0) },
      whoAccessedThisRecord: accessLog,
    };
    await this.audit.record({ action: 'export', entityType: 'subject_access_export', entityId: studentId, studentId }, actor);
    return { status: 'completed', generatedAt: new Date().toISOString(), data: JSON.parse(JSON.stringify(data, (_k, v) => (v && v.type === 'Buffer' ? undefined : v))) };
  }

  // ---------------- retention ----------------

  /** Students who left more than `retention.student_records_years_after_leaving` years ago and are not anonymised yet. */
  async retentionCandidates(q: z.infer<typeof RetentionQuery>) {
    const years = await this.retentionYears();
    const rows = await sql<{ id: string; student_code: string; first_name: string; last_name: string; status: string; left_on: string; total: string }>`
      WITH left_dates AS (
        SELECT s.id, s.student_code, s.first_name, s.last_name, s.status::text AS status,
               coalesce((SELECT max(h.effective_date) FROM app.student_status_history h WHERE h.student_id = s.id AND h.to_status = s.status),
                        (SELECT max(e.end_date) FROM app.enrolments e WHERE e.student_id = s.id),
                        s.updated_at::date) AS left_on
        FROM app.students s
        WHERE s.status IN ('withdrawn', 'transferred_out', 'graduated', 'deceased')
          AND NOT EXISTS (SELECT 1 FROM app.retention_actions r WHERE r.entity_type = 'student' AND r.entity_id = s.id AND r.action = 'anonymised')
      )
      SELECT *, count(*) OVER () AS total FROM left_dates
      WHERE left_on < (now() AT TIME ZONE 'Africa/Accra')::date - make_interval(years => ${years})
      ORDER BY left_on LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`.execute(this.db);
    return {
      retentionYears: years,
      page: q.page, pageSize: q.pageSize, total: Number(rows.rows[0]?.total ?? 0),
      data: rows.rows.map((r) => ({ studentId: r.id, studentCode: r.student_code, fullName: `${r.first_name} ${r.last_name}`, status: r.status === 'graduated' ? 'alumni' : r.status, leftOn: String(r.left_on).slice(0, 10) })),
    };
  }

  // ---------------- anonymisation ----------------

  /**
   * Irreversibly replaces a former student's personal data. Kept: student_code, admission year/sequence, gender,
   * birth year, enrolment history (classes and dates), and all finance records (statutory retention; amounts only,
   * descriptions untouched). Guardians linked only to this student are anonymised too.
   * Append-only tables (emergency_contact_logs, audit.events) are not changed; they are covered by their own retention period.
   */
  async anonymiseStudent(studentId: string, b: z.infer<typeof AnonymiseBody>, actor: AuthUser): Promise<{ studentId: string; studentCode: string; anonymisedAt: string; guardiansAnonymised: number }> {
    return this.db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom('students').select(['id', 'student_code', 'status', 'date_of_birth']).where('id', '=', studentId).forUpdate().executeTakeFirst();
      if (!s) throw AppError.notFound('student');
      if (b.confirmStudentCode.toUpperCase() !== s.student_code) {
        throw new AppError(422, ErrorCodes.DPA_ANONYMISE_CONFIRMATION_REQUIRED, 'Type the student code exactly to confirm',
          'Anonymisation cannot be undone, so the student code must be typed to confirm.', [{ field: 'confirmStudentCode', code: 'MISMATCH', message: `Type ${s.student_code}` }]);
      }
      if (!(LEFT_STATUSES as readonly string[]).includes(s.status)) {
        throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Only former students can be anonymised', 'Complete the withdrawal, transfer or graduation first.');
      }
      if (await tx.selectFrom('retention_actions').select('id').where('entity_type', '=', 'student').where('entity_id', '=', studentId).where('action', '=', 'anonymised').executeTakeFirst()) {
        throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'This student was already anonymised');
      }
      const now = new Date();
      const birthYear = String(s.date_of_birth).slice(0, 4);
      await tx.updateTable('students').set({
        first_name: 'Anonymised', middle_names: null, last_name: 'Student', preferred_name: null, date_of_birth: `${birthYear}-01-01`,
        nationality: null, home_address: null, previous_school: null, photo_file_id: null, birth_cert_no: null, religion: null, languages: [],
        updated_at: now, updated_by: actor.id, version: sql`version + 1`,
      }).where('id', '=', studentId).execute();
      await tx.updateTable('student_medical').set({
        blood_group: null, allergies_enc: null, chronic_conditions_enc: null, medication_notes_enc: null, special_needs_enc: null,
        doctor_name: null, clinic_name: null, clinic_phone: null, alert_summary: null, has_alert: false, updated_at: now, updated_by: actor.id,
      }).where('student_id', '=', studentId).execute();
      await tx.updateTable('incidents').set({ description: ANON, action_taken: null, follow_up: null }).where('student_id', '=', studentId).execute();
      await tx.updateTable('health_visits').set({ complaint: ANON, treatment_given: null, medication_given: null }).where('student_id', '=', studentId).execute();
      await tx.updateTable('attendance_records').set({ note: null }).where('student_id', '=', studentId).execute();
      await tx.updateTable('term_scores').set({ subject_remark: null }).where('student_id', '=', studentId).execute();
      await tx.deleteFrom('emergency_contacts').where('student_id', '=', studentId).execute();
      await tx.deleteFrom('authorised_pickups').where('student_id', '=', studentId).execute();
      await tx.updateTable('student_documents').set({ archived_at: now, archived_by: actor.id, archive_reason: 'anonymised', notes: null }).where('student_id', '=', studentId).where('archived_at', 'is', null).execute();

      const guardiansAnonymised = await this.anonymiseSoleGuardians(tx, studentId, actor, now);
      await tx.insertInto('retention_actions').values({ entity_type: 'student', entity_id: studentId, action: 'anonymised', basis: b.reason, approved_by: actor.id, performed_by: actor.id }).execute();
      await this.audit.record({ action: 'update', entityType: 'student', entityId: studentId, studentId, reason: `anonymised: ${b.reason}`,
        changes: { personalData: { after: 'anonymised' }, guardiansAnonymised: { after: guardiansAnonymised } } }, actor, tx);
      return { studentId, studentCode: s.student_code, anonymisedAt: now.toISOString(), guardiansAnonymised };
    });
  }

  private async anonymiseSoleGuardians(tx: Tx, studentId: string, actor: AuthUser, now: Date): Promise<number> {
    const sole = await sql<{ guardian_id: string }>`
      SELECT sg.guardian_id FROM app.student_guardians sg
      WHERE sg.student_id = ${studentId}
        AND NOT EXISTS (SELECT 1 FROM app.student_guardians o WHERE o.guardian_id = sg.guardian_id AND o.student_id <> ${studentId})`.execute(tx);
    for (const { guardian_id } of sole.rows) {
      await tx.updateTable('guardians').set({
        first_name: 'Anonymised', last_name: 'Guardian', title: null, phone_primary: '+233000000000', phone_secondary: null, whatsapp_number: null, email: null,
        occupation: null, workplace: null, home_address: null, work_address: null, ghana_card_enc: null, ghana_card_bidx: null, ghana_card_last4: null,
        updated_at: now, updated_by: actor.id, version: sql`version + 1`,
      }).where('id', '=', guardian_id).execute();
      await tx.insertInto('retention_actions').values({ entity_type: 'guardian', entity_id: guardian_id, action: 'anonymised', basis: `with student ${studentId}`, approved_by: actor.id, performed_by: actor.id }).execute();
    }
    return sole.rows.length;
  }

  private async retentionYears(): Promise<number> {
    const r = await this.db.selectFrom('settings').select(sql<string>`value #>> '{}'`.as('v')).where('key', '=', 'retention.student_records_years_after_leaving').executeTakeFirst();
    const n = Number(r?.v ?? 7);
    return Number.isInteger(n) && n >= 0 ? n : 7;
  }
}
