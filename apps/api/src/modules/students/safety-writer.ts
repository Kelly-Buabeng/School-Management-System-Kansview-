// Owner: Agent B. Medical record encryption and emergency-contact writes (admission, medical API, emergency API, import).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import type { Tx } from '../../common/db/database.module';
import { FIELD_CRYPTO, type FieldCrypto } from '../../security/field-crypto';
import { isoInstant } from '../settings/common/db';
import { normaliseContacts } from './admission-rules';
import type { EmergencyContactInput, StudentMedicalInput } from './students.dto';

const ENC_FIELDS = [
  ['allergies', 'allergies_enc'], ['chronicConditions', 'chronic_conditions_enc'],
  ['medicationNotes', 'medication_notes_enc'], ['specialNeeds', 'special_needs_enc'],
] as const;

export interface MedicalDto {
  bloodGroup: string | null;
  allergies: string | null;
  chronicConditions: string | null;
  medicationNotes: string | null;
  specialNeeds: string | null;
  doctorName: string | null;
  clinicName: string | null;
  clinicPhone: string | null;
  alertSummary: string | null;
  hasAlert: boolean;
  version: number;
  updatedAt: string | null;
}

@Injectable()
export class SafetyWriter {
  private readonly logger = new Logger('SafetyWriter');
  constructor(@Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto) {}

  decrypt(buf: Buffer | Uint8Array | null | undefined, context: string): string | null {
    if (!buf) return null;
    try {
      return this.crypto.decrypt(Buffer.from(buf));
    } catch (err) {
      this.logger.error({ err: (err as Error).message, context }, 'could not decrypt a medical field');
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'This medical record could not be read. Tell the administrator.');
    }
  }

  async upsertMedical(tx: Tx, studentId: string, m: StudentMedicalInput, actorId: string): Promise<void> {
    const enc = (v: string | undefined) => (v && v.length ? this.crypto.encrypt(v) : null);
    const alert = m.alertSummary?.trim() || null;
    const values = {
      blood_group: m.bloodGroup && m.bloodGroup !== 'unknown' ? m.bloodGroup : null,
      allergies_enc: enc(m.allergies), chronic_conditions_enc: enc(m.chronicConditions),
      medication_notes_enc: enc(m.medicationNotes), special_needs_enc: enc(m.specialNeeds),
      doctor_name: m.doctorName ?? null, clinic_name: m.clinicName ?? null, clinic_phone: m.clinicPhone ?? null,
      alert_summary: alert, has_alert: !!alert, updated_by: actorId,
    };
    await tx.insertInto('student_medical').values({ student_id: studentId, ...values, created_by: actorId })
      .onConflict((oc) => oc.column('student_id').doUpdateSet(values)).execute();
  }

  async readMedical(tx: Tx | import('../../common/db/database.module').Db, studentId: string): Promise<MedicalDto | null> {
    const r = await tx.selectFrom('student_medical').selectAll().where('student_id', '=', studentId).executeTakeFirst();
    if (!r) return null;
    const out: Record<string, string | null> = {};
    for (const [api, col] of ENC_FIELDS) out[api] = this.decrypt(r[col], `${studentId}.${col}`);
    return {
      bloodGroup: r.blood_group, allergies: out.allergies ?? null, chronicConditions: out.chronicConditions ?? null,
      medicationNotes: out.medicationNotes ?? null, specialNeeds: out.specialNeeds ?? null, doctorName: r.doctor_name, clinicName: r.clinic_name,
      clinicPhone: r.clinic_phone, alertSummary: r.alert_summary, hasAlert: r.has_alert, version: r.version, updatedAt: isoInstant(r.updated_at),
    };
  }

  /** Replaces the ordered contact list in one transaction. Linked guardians must belong to the student. */
  async replaceContacts(tx: Tx, studentId: string, contacts: EmergencyContactInput[], actorId: string): Promise<void> {
    const ordered = normaliseContacts(contacts);
    const guardianIds = ordered.map((c) => c.guardianId).filter((x): x is string => !!x);
    if (guardianIds.length) {
      const linked = await tx.selectFrom('student_guardians').select('guardian_id').where('student_id', '=', studentId).where('guardian_id', 'in', guardianIds).execute();
      const ok = new Set(linked.map((l) => l.guardian_id));
      const bad = guardianIds.find((g) => !ok.has(g));
      if (bad) {
        throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'An emergency contact is not one of this student\'s guardians', undefined, [
          { field: 'emergencyContacts', code: 'NOT_LINKED', message: 'Link the guardian to the student first, or enter a name and phone' },
        ]);
      }
    }
    await tx.deleteFrom('emergency_contacts').where('student_id', '=', studentId).execute();
    if (ordered.length) {
      await tx.insertInto('emergency_contacts').values(ordered.map((c) => ({
        student_id: studentId, priority: c.priority, guardian_id: c.guardianId ?? null, name: c.name ?? null, phone: c.phone ?? null,
        relationship: c.relationship ?? null, notes: c.notes ?? null, created_by: actorId, updated_by: actorId,
      }))).execute();
    }
  }
}
