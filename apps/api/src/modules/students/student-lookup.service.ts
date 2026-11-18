// Owner: Agent B. Implementations of the StudentLookup (finance, notifications, documents) and ImportTarget (imports) contracts.
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes, normaliseGhanaPhone } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import type { ImportStudentRow, ImportTarget, StudentBillingInfo, StudentLookup } from '../../common/contracts';
import { fullNameSql, guardianNameSql } from '../settings/common/db';
import { RELATIONSHIPS } from '../guardians/guardians.dto';
import { AdmissionService } from './admission.service';
import { AdmitStudentBody } from './students.dto';

@Injectable()
export class StudentLookupService implements StudentLookup {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async getBillingInfo(studentId: string, tx?: unknown): Promise<StudentBillingInfo | null> {
    const db = (tx as Tx | undefined) ?? this.db;
    const s = await db.selectFrom('students as s')
      .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null))
      .leftJoin('classes as c', 'c.id', 'e.class_id')
      .select(['s.id', 's.student_code', 's.status', fullNameSql('s').as('full_name'), 'c.id as class_id', 'c.display_name', 'c.level_id'])
      .where('s.id', '=', studentId).executeTakeFirst();
    if (!s) return null;
    const payers = await db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .select(['g.id', guardianNameSql('g').as('full_name'), 'g.phone_primary', 'sg.is_fee_payer', 'sg.is_primary'])
      .where('sg.student_id', '=', studentId).where('g.archived_at', 'is', null)
      .orderBy('sg.is_fee_payer', 'desc').orderBy('sg.is_primary', 'desc').execute();
    const feePayers = payers.some((p) => p.is_fee_payer) ? payers.filter((p) => p.is_fee_payer) : payers.slice(0, 1);
    return {
      studentId: s.id, studentCode: s.student_code, fullName: s.full_name, classId: s.class_id, className: s.display_name, levelId: s.level_id,
      status: s.status === 'graduated' ? 'alumni' : s.status,
      feePayers: feePayers.map((p) => ({ guardianId: p.id, fullName: p.full_name, phone: p.phone_primary })),
    };
  }

  async listActiveStudentIds(scope: { classIds?: string[]; levelIds?: string[]; school?: boolean }, academicYearId?: string): Promise<string[]> {
    let q = this.db.selectFrom('enrolments as e').innerJoin('students as s', 's.id', 'e.student_id').innerJoin('classes as c', 'c.id', 'e.class_id')
      .select('s.id').where('e.end_date', 'is', null).where('s.status', '=', 'active').where('s.archived_at', 'is', null);
    if (academicYearId) q = q.where('e.academic_year_id', '=', academicYearId);
    else q = q.where('e.academic_year_id', '=', (eb) => eb.selectFrom('academic_years').select('id').where('status', '=', 'current').limit(1));
    if (!scope.school) {
      const classIds = scope.classIds ?? [];
      const levelIds = scope.levelIds ?? [];
      if (!classIds.length && !levelIds.length) return [];
      q = q.where((eb) => eb.or([
        ...(classIds.length ? [eb('c.id', 'in', classIds)] : []),
        ...(levelIds.length ? [eb('c.level_id', 'in', levelIds)] : []),
      ]));
    }
    return (await q.orderBy('s.id').execute()).map((r) => r.id);
  }

  async smsRecipients(studentId: string, primaryOnly: boolean): Promise<Array<{ guardianId: string; phone: string }>> {
    let q = this.db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .select(['g.id', 'g.phone_primary']).where('sg.student_id', '=', studentId).where('sg.receives_sms', '=', true).where('g.archived_at', 'is', null);
    if (primaryOnly) q = q.where('sg.is_primary', '=', true);
    const rows = await q.orderBy('sg.is_primary', 'desc').orderBy('g.last_name').execute();
    return rows.map((r) => ({ guardianId: r.id, phone: r.phone_primary }));
  }
}

@Injectable()
export class StudentImportTarget implements ImportTarget {
  constructor(private readonly admission: AdmissionService) {}

  async upsertStudentWithGuardians(row: ImportStudentRow, tx: unknown, actorUserId: string): Promise<{ studentId: string; studentCode: string; guardianIds: string[] }> {
    const t = tx as Tx;
    if (!t || typeof (t as { selectFrom?: unknown }).selectFrom !== 'function') throw new Error('ImportTarget needs a Kysely transaction');
    const guardians = [];
    for (const g of row.guardians) {
      const phone = normaliseGhanaPhone(g.phonePrimary);
      if (!phone) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, `Guardian ${g.firstName} ${g.lastName}: phone number is not valid`);
      // De-duplicate guardians by phone so siblings link automatically.
      let existingId = g.existingGuardianId;
      if (!existingId) {
        const found = await t.selectFrom('guardians').select('id').where('phone_primary', '=', phone).where('archived_at', 'is', null).orderBy('created_at').executeTakeFirst();
        existingId = found?.id;
      }
      const relationship = (RELATIONSHIPS as readonly string[]).includes(g.relationship.toLowerCase()) ? g.relationship.toLowerCase() : 'other';
      const flags = { relationship, isPrimary: g.isPrimary, isFeePayer: g.isFeePayer, canPickUp: g.canPickUp };
      guardians.push(existingId ? { guardianId: existingId, ...flags } : {
        ...flags,
        newGuardian: {
          firstName: g.firstName, lastName: g.lastName, phonePrimary: g.phonePrimary,
          ...(g.phoneSecondary && { phoneSecondary: g.phoneSecondary }), ...(g.whatsappNumber && { whatsappNumber: g.whatsappNumber }),
          ...(g.email && { email: g.email }), ...(g.occupation && { occupation: g.occupation }),
        },
      });
    }
    const medical = row.medical && Object.values(row.medical).some(Boolean)
      ? { ...(row.medical.allergies && { allergies: row.medical.allergies }), ...(row.medical.chronicConditions && { chronicConditions: row.medical.chronicConditions }),
          ...(row.medical.bloodGroup && { bloodGroup: row.medical.bloodGroup }), ...(row.medical.alertSummary && { alertSummary: row.medical.alertSummary }) }
      : undefined;
    const body = AdmitStudentBody.parse({
      firstName: row.firstName, lastName: row.lastName, dateOfBirth: row.dateOfBirth, gender: row.gender, admissionDate: row.admissionDate, classId: row.classId,
      ...(row.middleNames && { middleNames: row.middleNames }), ...(row.preferredName && { preferredName: row.preferredName }),
      ...(row.previousSchool && { previousSchool: row.previousSchool }), ...(row.homeAddress && { homeAddress: row.homeAddress }),
      ...(row.nationality && { nationality: row.nationality }), ...(row.religion && { religion: row.religion }), ...(row.languages && { languages: row.languages }),
      guardians, ...(medical && { medical }),
    });
    const r = await this.admission.admit(body, { id: actorUserId }, { tx: t, source: 'import', legacyNote: row.legacyId ? `Imported (old ID ${row.legacyId})` : 'Imported' });
    return { studentId: r.studentId, studentCode: r.studentCode, guardianIds: r.guardianIds };
  }
}
