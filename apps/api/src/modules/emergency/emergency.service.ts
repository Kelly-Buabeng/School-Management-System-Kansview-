// Owner: Agent B. Emergency View (always audited), ordered contacts, contact log, authorised pickups.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { apiStatus, isoInstant } from '../settings/common/db';
import { parseId, telLink } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { SafetyWriter } from '../students/safety-writer';
import { photoUrl } from '../students/student-reader';
import type { EmergencyContactInput } from '../students/students.dto';

interface ViewRow {
  id: string; student_code: string; full_name: string; preferred_name: string | null; status: string; photo_file_id: string | null;
  date_of_birth: string; class_id: string | null; class_name: string | null; roll_number: number | null;
  blood_group: string | null; alert_summary: string | null; has_alert: boolean | null; allergies_enc: Buffer | null;
  doctor_name: string | null; clinic_name: string | null; clinic_phone: string | null;
  contacts: Array<{ id: string; priority: number; guardian_id: string | null; name: string; relationship: string | null; notes: string | null; phones: string[] }>;
  pickups: Array<{ id: string; guardian_id: string | null; name: string; relationship: string | null; phone: string | null; photo_file_id: string | null; id_type: string | null; id_number_last4: string | null; verification_notes: string | null; valid_from: string | null; valid_to: string | null }>;
  logs: Array<{ id: string; contact_ref: string | null; phone_called: string; outcome: string; notes: string | null; contacted_by_name: string | null; contacted_at: string }>;
}

@Injectable()
export class EmergencyService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    private readonly access: RecordAccess,
    private readonly safety: SafetyWriter,
  ) {}

  /** Everything staff need in an emergency, in ONE query. Always audited as emergency_view. */
  async view(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const today = todayInAccra();
    const r = (await sql<ViewRow>`
      SELECT s.id, s.student_code, concat_ws(' ', s.first_name, nullif(s.middle_names, ''), s.last_name) AS full_name, s.preferred_name,
             s.status::text AS status, s.photo_file_id, s.date_of_birth::text AS date_of_birth,
             c.id AS class_id, c.display_name AS class_name, e.roll_number,
             m.blood_group, m.alert_summary, m.has_alert, m.allergies_enc, m.doctor_name, m.clinic_name, m.clinic_phone,
             coalesce((SELECT json_agg(x ORDER BY x.priority) FROM (
                SELECT ec.id, ec.priority, ec.guardian_id,
                       coalesce(ec.name, g.first_name || ' ' || g.last_name) AS name,
                       coalesce(ec.relationship, sg.relationship::text) AS relationship, ec.notes,
                       array_remove(ARRAY[coalesce(ec.phone, g.phone_primary), CASE WHEN ec.phone IS NULL THEN g.phone_secondary END,
                                          CASE WHEN ec.phone IS NULL AND g.whatsapp_number IS DISTINCT FROM g.phone_primary THEN g.whatsapp_number END], NULL) AS phones
                  FROM app.emergency_contacts ec
                  LEFT JOIN app.guardians g ON g.id = ec.guardian_id
                  LEFT JOIN app.student_guardians sg ON sg.student_id = ec.student_id AND sg.guardian_id = ec.guardian_id
                 WHERE ec.student_id = s.id) x), '[]'::json) AS contacts,
             coalesce((SELECT json_agg(p ORDER BY p.name) FROM (
                SELECT ap.id, ap.guardian_id, coalesce(ap.name, g.first_name || ' ' || g.last_name) AS name, ap.relationship,
                       coalesce(ap.phone, g.phone_primary) AS phone, ap.photo_file_id, ap.id_type, ap.id_number_last4, ap.verification_notes,
                       ap.valid_from::text AS valid_from, ap.valid_to::text AS valid_to
                  FROM app.authorised_pickups ap LEFT JOIN app.guardians g ON g.id = ap.guardian_id
                 WHERE ap.student_id = s.id AND ap.archived_at IS NULL
                   AND (ap.valid_from IS NULL OR ap.valid_from <= ${today}::date) AND (ap.valid_to IS NULL OR ap.valid_to >= ${today}::date)) p), '[]'::json) AS pickups,
             coalesce((SELECT json_agg(l ORDER BY l.contacted_at DESC) FROM (
                SELECT cl.id, cl.contact_ref, cl.phone_called, cl.outcome::text AS outcome, cl.notes, u.full_name AS contacted_by_name, cl.contacted_at
                  FROM app.emergency_contact_logs cl LEFT JOIN app.users u ON u.id = cl.contacted_by
                 WHERE cl.student_id = s.id ORDER BY cl.contacted_at DESC LIMIT 10) l), '[]'::json) AS logs
        FROM app.students s
        LEFT JOIN app.enrolments e ON e.student_id = s.id AND e.end_date IS NULL
        LEFT JOIN app.classes c ON c.id = e.class_id
        LEFT JOIN app.student_medical m ON m.student_id = s.id
       WHERE s.id = ${s.id}::uuid`.execute(this.db)).rows[0];
    if (!r) throw AppError.notFound('student');
    await this.audit.record({ action: 'emergency_view', entityType: 'student', entityId: s.id, studentId: s.id }, user);
    return {
      student: {
        id: r.id, studentCode: r.student_code, fullName: r.full_name, preferredName: r.preferred_name, className: r.class_name, classId: r.class_id,
        rollNumber: r.roll_number, status: apiStatus(r.status), photoUrl: photoUrl(r.photo_file_id), hasMedicalAlert: !!r.has_alert, dateOfBirth: r.date_of_birth,
      },
      bloodGroup: r.blood_group,
      alertSummary: r.alert_summary,
      hasMedicalAlert: !!r.has_alert,
      allergies: this.safety.decrypt(r.allergies_enc, `${s.id}.allergies_enc`),
      contacts: r.contacts.map((c) => ({
        id: c.id, priority: c.priority, guardianId: c.guardian_id, name: c.name, relationship: c.relationship, notes: c.notes,
        phones: c.phones, telLinks: c.phones.map(telLink),
      })),
      authorisedPickups: r.pickups.map((p) => ({
        id: p.id, guardianId: p.guardian_id, name: p.name, relationship: p.relationship, phone: p.phone, telLink: p.phone ? telLink(p.phone) : null,
        photoUrl: photoUrl(p.photo_file_id), idType: p.id_type, idNumberLast4: p.id_number_last4, verificationNotes: p.verification_notes, validFrom: p.valid_from, validTo: p.valid_to,
      })),
      doctor: { name: r.doctor_name, clinic: r.clinic_name, phone: r.clinic_phone, telLink: r.clinic_phone ? telLink(r.clinic_phone) : null },
      recentContactLog: r.logs.map((l) => ({ id: l.id, contactRef: l.contact_ref, phoneCalled: l.phone_called, outcome: l.outcome, notes: l.notes, contactedBy: l.contacted_by_name, contactedAt: isoInstant(l.contacted_at) })),
    };
  }

  async listContacts(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const rows = await this.db.selectFrom('emergency_contacts as ec').leftJoin('guardians as g', 'g.id', 'ec.guardian_id')
      .select(['ec.id', 'ec.priority', 'ec.guardian_id', 'ec.name', 'ec.phone', 'ec.relationship', 'ec.notes', 'g.first_name', 'g.last_name', 'g.phone_primary'])
      .where('ec.student_id', '=', s.id).orderBy('ec.priority').execute();
    return rows.map((r) => ({
      id: r.id, priority: r.priority, guardianId: r.guardian_id, name: r.name ?? (r.first_name ? `${r.first_name} ${r.last_name}` : null),
      phone: r.phone ?? r.phone_primary, relationship: r.relationship, notes: r.notes,
    }));
  }

  async replaceContacts(rawId: string, contacts: EmergencyContactInput[], user: AuthUser) {
    const s = await this.access.student(user, rawId);
    await this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('emergency_contacts').select(['priority', 'guardian_id', 'name']).where('student_id', '=', s.id).orderBy('priority').execute();
      await this.safety.replaceContacts(tx, s.id, contacts, user.id);
      await this.audit.record({ action: 'update', entityType: 'emergency_contacts', entityId: s.id, studentId: s.id, changes: { contacts: { before: before.length, after: contacts.length } } }, user, tx);
    });
    return this.listContacts(s.id, user);
  }

  async listLogs(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const rows = await this.db.selectFrom('emergency_contact_logs as l').leftJoin('users as u', 'u.id', 'l.contacted_by')
      .select(['l.id', 'l.contact_ref', 'l.phone_called', 'l.outcome', 'l.notes', 'l.contacted_at', 'u.full_name'])
      .where('l.student_id', '=', s.id).orderBy('l.contacted_at', 'desc').limit(200).execute();
    return rows.map((l) => ({ id: l.id, contactRef: l.contact_ref, phoneCalled: l.phone_called, outcome: l.outcome, notes: l.notes, contactedBy: l.full_name, contactedAt: isoInstant(l.contacted_at) }));
  }

  async logContact(rawId: string, body: { contactRef?: string; phoneCalled: string; outcome: string; notes?: string }, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    return this.db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('emergency_contact_logs').values({
        student_id: s.id, contact_ref: body.contactRef ?? null, phone_called: body.phoneCalled, outcome: body.outcome as never, notes: body.notes ?? null, contacted_by: user.id,
      }).returning(['id', 'contacted_at']).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'emergency_contact_log', entityId: r.id, studentId: s.id, changes: { outcome: { after: body.outcome } } }, user, tx);
      return { id: r.id, contactRef: body.contactRef ?? null, phoneCalled: body.phoneCalled, outcome: body.outcome, notes: body.notes ?? null, contactedAt: isoInstant(r.contacted_at) };
    });
  }

  // ---------------- pickups ----------------
  async listPickups(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const rows = await this.db.selectFrom('authorised_pickups as ap').leftJoin('guardians as g', 'g.id', 'ap.guardian_id')
      .selectAll('ap').select(['g.first_name', 'g.last_name', 'g.phone_primary'])
      .where('ap.student_id', '=', s.id).where('ap.archived_at', 'is', null).orderBy('ap.created_at').execute();
    return rows.map((p) => ({
      id: p.id, guardianId: p.guardian_id, name: p.name ?? (p.first_name ? `${p.first_name} ${p.last_name}` : null), relationship: p.relationship,
      phone: p.phone ?? p.phone_primary, photoUrl: photoUrl(p.photo_file_id), idType: p.id_type, idNumberLast4: p.id_number_last4,
      verificationNotes: p.verification_notes, validFrom: p.valid_from, validTo: p.valid_to,
    }));
  }

  private pickupValues(b: Record<string, string | null | undefined>) {
    const map: Record<string, string> = { guardianId: 'guardian_id', name: 'name', relationship: 'relationship', phone: 'phone', idType: 'id_type', idNumberLast4: 'id_number_last4', verificationNotes: 'verification_notes', validFrom: 'valid_from', validTo: 'valid_to' };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined && map[k]) out[map[k]] = v;
    return out;
  }

  private async checkPickupGuardian(studentId: string, guardianId: string | null | undefined) {
    if (!guardianId) return;
    const g = await this.db.selectFrom('guardians').select('id').where('id', '=', guardianId).where('archived_at', 'is', null).executeTakeFirst();
    if (!g) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'This guardian was not found', undefined, [{ field: 'guardianId', code: 'NOT_FOUND', message: 'Choose a guardian' }]);
    void studentId;
  }

  async addPickup(rawId: string, body: Record<string, string | undefined>, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    if (body.validFrom && body.validTo && body.validTo < body.validFrom) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'The end date is before the start date');
    await this.checkPickupGuardian(s.id, body.guardianId);
    const id = await this.db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('authorised_pickups').values({ student_id: s.id, ...this.pickupValues(body), created_by: user.id, updated_by: user.id } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'authorised_pickup', entityId: r.id, studentId: s.id }, user, tx);
      return r.id;
    });
    return (await this.listPickups(s.id, user)).find((p) => p.id === id);
  }

  async updatePickup(rawId: string, rawPickupId: string, body: Record<string, string | null | undefined>, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const pid = parseId(rawPickupId, 'pickup');
    await this.checkPickupGuardian(s.id, body.guardianId);
    await this.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('authorised_pickups').set({ ...this.pickupValues(body), updated_by: user.id } as never)
        .where('id', '=', pid).where('student_id', '=', s.id).where('archived_at', 'is', null).returning('id').executeTakeFirst();
      if (!r) throw AppError.notFound('pickup');
      await this.audit.record({ action: 'update', entityType: 'authorised_pickup', entityId: pid, studentId: s.id, changes: Object.fromEntries(Object.keys(body).map((k) => [k, { after: '[changed]' }])) }, user, tx);
    });
    return (await this.listPickups(s.id, user)).find((p) => p.id === pid);
  }

  async archivePickup(rawId: string, rawPickupId: string, reason: string | undefined, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const pid = parseId(rawPickupId, 'pickup');
    await this.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('authorised_pickups').set({ archived_at: sql`now()`, archived_by: user.id, archive_reason: reason ?? null, updated_by: user.id })
        .where('id', '=', pid).where('student_id', '=', s.id).where('archived_at', 'is', null).returning('id').executeTakeFirst();
      if (!r) throw AppError.notFound('pickup');
      await this.audit.record({ action: 'archive', entityType: 'authorised_pickup', entityId: pid, studentId: s.id, reason: reason ?? null }, user, tx);
    });
  }
}
