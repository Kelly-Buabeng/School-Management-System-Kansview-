// Owner: Agent B. Student profile: list, view, update, archive, photo, medical, documents, siblings, status history.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db } from '../../common/db/database.module';
import { pageOffset, type Page } from '../../common/pagination';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_POLICY, type FieldPolicy } from '../../security/field-policy';
import { UPLOAD_PIPELINE, UPLOAD_POLICIES, type UploadPipeline } from '../../security/upload-pipeline';
import { LEDGER_SERVICE, type LedgerService } from '../../common/contracts';
import { apiStatus, dbStatus, guardianNameSql, isoInstant } from '../settings/common/db';
import { diffChanges, parseId, versionConflict } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { escapeLike } from '../search/classify';
import { AdmissionService } from './admission.service';
import { SafetyWriter } from './safety-writer';
import { StudentReader, type StudentDto, type StudentSummaryDto } from './student-reader';
import type { AdmitStudentBody, DuplicateCheckBody, ListStudentsQuery, StudentMedicalInput, UpdateStudentBody } from './students.dto';

export interface UploadedBlob { originalname: string; buffer: Buffer; mimetype?: string }

const FIELD_MAP: Record<keyof UpdateStudentBody, string> = {
  firstName: 'first_name', middleNames: 'middle_names', lastName: 'last_name', preferredName: 'preferred_name', dateOfBirth: 'date_of_birth',
  gender: 'gender', nationality: 'nationality', homeAddress: 'home_address', previousSchool: 'previous_school', admissionDate: 'admission_date',
  birthCertNo: 'birth_cert_no', religion: 'religion', languages: 'languages',
};

@Injectable()
export class StudentsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(FIELD_POLICY) private readonly fields: FieldPolicy,
    @Inject(UPLOAD_PIPELINE) private readonly uploads: UploadPipeline,
    @Inject(LEDGER_SERVICE) private readonly ledger: LedgerService,
    private readonly access: RecordAccess,
    private readonly reader: StudentReader,
    private readonly admission: AdmissionService,
    private readonly safety: SafetyWriter,
  ) {}

  async admit(body: AdmitStudentBody, user: AuthUser) {
    const r = await this.admission.admit(body, user);
    return this.view(r.studentId, user, { audit: false });
  }

  duplicateCheck(body: DuplicateCheckBody) {
    return this.admission.findDuplicates(body).then((candidates) => ({ isPossibleDuplicate: candidates.length > 0, candidates }));
  }

  async list(user: AuthUser, q: ListStudentsQuery): Promise<Page<StudentSummaryDto>> {
    const allowed = await this.access.allowedClassIds(user);
    if (allowed && allowed.length === 0) return { data: [], page: q.page, pageSize: q.pageSize, total: 0 };
    let query = this.reader.base().where('s.archived_at', 'is', null);
    if (allowed) query = query.where('e.class_id', 'in', allowed);
    if (q.classId) query = query.where('e.class_id', '=', q.classId);
    if (q.levelId) query = query.where('c.level_id', '=', q.levelId);
    query = query.where('s.status', '=', dbStatus(q.status ?? 'active'));
    if (q.q) {
      const text = q.q.toLowerCase();
      const like = `%${escapeLike(text)}%`;
      query = query.where((eb) => eb.or([
        eb(sql`lower(s.first_name || ' ' || coalesce(s.middle_names || ' ', '') || s.last_name)`, 'like', like),
        eb(sql`lower(s.preferred_name)`, 'like', like),
        eb(sql`lower(s.student_code)`, 'like', `${escapeLike(text)}%`),
        eb(sql<number>`similarity(lower(s.first_name || ' ' || coalesce(s.middle_names || ' ', '') || s.last_name), ${text})`, '>=', 0.3),
      ]));
    }
    const total = (await query.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n;
    const { limit, offset } = pageOffset(q);
    const sort = q.sort ?? 'lastName';
    let rows = query.select(this.reader.summaryColumns());
    if (sort === 'lastName' || sort === '-lastName') rows = rows.orderBy('s.last_name', sort === 'lastName' ? 'asc' : 'desc').orderBy('s.first_name');
    else if (sort === 'studentCode') rows = rows.orderBy('s.student_code');
    else rows = rows.orderBy('s.admission_date', sort === 'admissionDate' ? 'asc' : 'desc');
    const data = (await rows.orderBy('s.id').limit(limit).offset(offset).execute()).map((r) => this.reader.toSummary(r));
    return { data, page: q.page, pageSize: q.pageSize, total };
  }

  async get(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId, { includeArchived: user.permissions.has('students:archive') });
    return this.view(s.id, user, { audit: true });
  }

  private async view(id: string, user: AuthUser, opts: { audit: boolean }) {
    const dto = await this.reader.full(id);
    if (!dto) throw AppError.notFound('student');
    const out: StudentDto & { balancePesewas?: number; guardians?: unknown[] } = { ...dto };
    out.guardians = await this.guardianLinks(id);
    if (user.permissions.has('balances:read')) {
      out.balancePesewas = (await this.ledger.balance(id)).balancePesewas;
    }
    if (opts.audit) await this.audit.record({ action: 'view', entityType: 'student', entityId: id, studentId: id }, user);
    return this.fields.apply('student', out as unknown as Record<string, unknown>, user);
  }

  async guardianLinks(studentId: string) {
    const rows = await this.db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .select(['g.id', guardianNameSql('g').as('full_name'), 'g.phone_primary', 'g.phone_secondary', 'g.whatsapp_number', 'sg.relationship', 'sg.is_primary',
        'sg.is_fee_payer', 'sg.can_pick_up', 'sg.receives_sms', 'sg.lives_with_student'])
      .where('sg.student_id', '=', studentId).where('g.archived_at', 'is', null)
      .orderBy('sg.is_primary', 'desc').orderBy('g.last_name').execute();
    return rows.map((r) => ({
      guardianId: r.id, fullName: r.full_name, phonePrimary: r.phone_primary, phoneSecondary: r.phone_secondary, whatsappNumber: r.whatsapp_number,
      relationship: r.relationship, isPrimary: r.is_primary, isFeePayer: r.is_fee_payer, canPickUp: r.can_pick_up, receivesSms: r.receives_sms, livesWithStudent: r.lives_with_student,
    }));
  }

  async update(rawId: string, body: UpdateStudentBody, version: number, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    await this.db.transaction().execute(async (tx) => {
      const before = await this.reader.full(s.id, tx);
      if (!before) throw AppError.notFound('student');
      if (before.version !== version) throw versionConflict();
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[FIELD_MAP[k as keyof UpdateStudentBody]] = v;
      if (Object.keys(set).length === 0) return;
      const r = await tx.updateTable('students').set({ ...set, updated_by: user.id }).where('id', '=', s.id).where('version', '=', version).returning('id').executeTakeFirst();
      if (!r) throw versionConflict();
      const changes = diffChanges(before, body);
      if (changes.homeAddress) changes.homeAddress = { before: '[changed]', after: '[changed]' };
      await this.audit.record({ action: 'update', entityType: 'student', entityId: s.id, studentId: s.id, changes }, user, tx);
    });
    return this.view(s.id, user, { audit: false });
  }

  async archive(rawId: string, reason: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    await this.db.transaction().execute(async (tx) => {
      const today = todayInAccra();
      await tx.updateTable('students').set({ archived_at: sql`now()`, archived_by: user.id, archive_reason: reason, updated_by: user.id }).where('id', '=', s.id).execute();
      await tx.updateTable('enrolments').set({ end_date: sql`greatest(start_date, ${today}::date)`, status: 'withdrawn', reason: `Record archived: ${reason}`, updated_by: user.id })
        .where('student_id', '=', s.id).where('end_date', 'is', null).execute();
      await this.audit.record({ action: 'archive', entityType: 'student', entityId: s.id, studentId: s.id, reason }, user, tx);
    });
  }

  async uploadPhoto(rawId: string, file: UploadedBlob | undefined, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    if (!file) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a photo to upload');
    const accepted = await this.uploads.accept({ originalName: file.originalname, buffer: file.buffer, declaredMimeType: file.mimetype }, UPLOAD_POLICIES.passportPhoto, user.id);
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('students').set({ photo_file_id: accepted.fileId, updated_by: user.id }).where('id', '=', s.id).execute();
      await this.audit.record({ action: 'update', entityType: 'student', entityId: s.id, studentId: s.id, changes: { photoFileId: { after: accepted.fileId } } }, user, tx);
    });
    return { photoFileId: accepted.fileId, photoUrl: `/api/v1/files/${accepted.fileId}`, scanStatus: accepted.scanStatus };
  }

  // ---------------- medical ----------------
  async getMedical(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const m = await this.safety.readMedical(this.db, s.id);
    await this.audit.record({ action: 'view', entityType: 'student_medical', entityId: s.id, studentId: s.id }, user);
    const dto = m ?? { bloodGroup: null, allergies: null, chronicConditions: null, medicationNotes: null, specialNeeds: null, doctorName: null, clinicName: null, clinicPhone: null, alertSummary: null, hasAlert: false, version: 0, updatedAt: null };
    return this.fields.apply('medical', dto as unknown as Record<string, unknown>, user);
  }

  async putMedical(rawId: string, body: StudentMedicalInput, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    await this.db.transaction().execute(async (tx) => {
      await this.safety.upsertMedical(tx, s.id, body, user.id);
      // Sensitive values never go into the audit log: only which fields were saved.
      const changes = Object.fromEntries(Object.keys(body).map((k) => [k, { after: k === 'alertSummary' || k === 'bloodGroup' ? (body as Record<string, unknown>)[k] : '[saved]' }]));
      await this.audit.record({ action: 'update', entityType: 'student_medical', entityId: s.id, studentId: s.id, changes }, user, tx);
    });
    return this.safety.readMedical(this.db, s.id);
  }

  // ---------------- documents ----------------
  async listDocuments(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const rows = await this.db.selectFrom('student_documents as d').innerJoin('files as f', 'f.id', 'd.file_id')
      .select(['d.id', 'd.doc_type', 'd.notes', 'd.created_at', 'f.id as file_id', 'f.original_name', 'f.mime_type', 'f.size_bytes', 'f.scan_status'])
      .where('d.student_id', '=', s.id).where('d.archived_at', 'is', null).orderBy('d.created_at', 'desc').execute();
    return rows.map((r) => ({
      id: r.id, docType: r.doc_type, notes: r.notes, createdAt: isoInstant(r.created_at), fileId: r.file_id, originalName: r.original_name,
      mimeType: r.mime_type, sizeBytes: r.size_bytes, scanStatus: r.scan_status, downloadUrl: r.scan_status === 'clean' ? `/api/v1/files/${r.file_id}` : null,
    }));
  }

  async uploadDocument(rawId: string, file: UploadedBlob | undefined, meta: { docType: string; notes?: string }, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    if (!file) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a file to upload');
    const accepted = await this.uploads.accept({ originalName: file.originalname, buffer: file.buffer, declaredMimeType: file.mimetype }, UPLOAD_POLICIES.studentDocument, user.id);
    return this.db.transaction().execute(async (tx) => {
      const d = await tx.insertInto('student_documents').values({ student_id: s.id, file_id: accepted.fileId, doc_type: meta.docType as never, notes: meta.notes ?? null, created_by: user.id, updated_by: user.id })
        .returning(['id', 'created_at']).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'student_document', entityId: d.id, studentId: s.id, changes: { docType: { after: meta.docType } } }, user, tx);
      return { id: d.id, docType: meta.docType, notes: meta.notes ?? null, fileId: accepted.fileId, scanStatus: accepted.scanStatus, mimeType: accepted.mimeType, sizeBytes: accepted.sizeBytes, createdAt: isoInstant(d.created_at) };
    });
  }

  async archiveDocument(rawId: string, rawDocId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const docId = parseId(rawDocId, 'document');
    await this.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('student_documents').set({ archived_at: sql`now()`, archived_by: user.id, updated_by: user.id })
        .where('id', '=', docId).where('student_id', '=', s.id).where('archived_at', 'is', null).returning('id').executeTakeFirst();
      if (!r) throw AppError.notFound('document');
      await this.audit.record({ action: 'archive', entityType: 'student_document', entityId: docId, studentId: s.id }, user, tx);
    });
  }

  // ---------------- siblings & history ----------------
  async siblings(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const links = await this.db.selectFrom('v_sibling_links').select(['sibling_student_id', 'via_guardian_ids']).where('student_id', '=', s.id).execute();
    const ids = links.map((l) => l.sibling_student_id!).filter(Boolean);
    const summaries = await this.reader.summaries(ids);
    return links.filter((l) => summaries.has(l.sibling_student_id!)).map((l) => ({ ...summaries.get(l.sibling_student_id!)!, viaGuardianIds: l.via_guardian_ids ?? [] }));
  }

  async statusHistory(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId, { includeArchived: true });
    const rows = await this.db.selectFrom('student_status_history').selectAll().where('student_id', '=', s.id).orderBy('created_at').orderBy('id').execute();
    return rows.map((r) => ({
      id: r.id, fromStatus: r.from_status ? apiStatus(r.from_status) : null, toStatus: apiStatus(r.to_status), effectiveDate: r.effective_date,
      reason: r.reason, source: r.source, sourceRefId: r.source_ref_id, createdAt: isoInstant(r.created_at),
    }));
  }
}
