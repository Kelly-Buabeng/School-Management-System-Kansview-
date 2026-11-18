// Owner: Agent B. Read model for students (summary + full profile). Shared by students, guardians, search, promotion.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { apiStatus, fullNameSql, isoInstant } from '../settings/common/db';

export interface StudentSummaryDto {
  id: string;
  studentCode: string;
  fullName: string;
  preferredName: string | null;
  className: string | null;
  classId: string | null;
  rollNumber: number | null;
  status: string;
  photoUrl: string | null;
  hasMedicalAlert: boolean;
}

export interface EnrolmentDto {
  id: string;
  classId: string;
  className: string;
  academicYearId: string;
  academicYear: string;
  rollNumber: number | null;
  startDate: string;
  endDate: string | null;
  status: string;
  reason: string | null;
}

export interface StudentDto extends StudentSummaryDto {
  firstName: string;
  middleNames: string | null;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  nationality: string | null;
  homeAddress: string | null;
  previousSchool: string | null;
  admissionDate: string;
  admissionClassId: string | null;
  admissionYear: number;
  currentEnrolment: EnrolmentDto | null;
  birthCertNo: string | null;
  religion: string | null;
  languages: string[];
  archivedAt: string | null;
  archiveReason: string | null;
  version: number;
  createdAt: string | null;
}

export const photoUrl = (fileId: string | null) => (fileId ? `/api/v1/files/${fileId}` : null);

@Injectable()
export class StudentReader {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  /** Base query: student + open enrolment + class + medical alert flag. */
  base(db: Db | Tx = this.db) {
    return db.selectFrom('students as s')
      .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null))
      .leftJoin('classes as c', 'c.id', 'e.class_id')
      .leftJoin('academic_years as y', 'y.id', 'e.academic_year_id')
      .leftJoin('student_medical as m', 'm.student_id', 's.id');
  }

  summaryColumns() {
    return [
      's.id', 's.student_code', 's.preferred_name', 's.status', 's.photo_file_id', 'c.display_name as class_name', 'c.id as class_id',
      'e.roll_number', fullNameSql('s').as('full_name'), sql<boolean>`coalesce(m.has_alert, false)`.as('has_alert'),
    ] as const;
  }

  toSummary(r: { id: string; student_code: string; preferred_name: string | null; status: string; photo_file_id: string | null; class_name: string | null; class_id: string | null; roll_number: number | null; full_name: string; has_alert: boolean }): StudentSummaryDto {
    return {
      id: r.id, studentCode: r.student_code, fullName: r.full_name, preferredName: r.preferred_name, className: r.class_name, classId: r.class_id,
      rollNumber: r.roll_number, status: apiStatus(r.status), photoUrl: photoUrl(r.photo_file_id), hasMedicalAlert: !!r.has_alert,
    };
  }

  async summaries(ids: string[], tx?: Tx): Promise<Map<string, StudentSummaryDto>> {
    if (ids.length === 0) return new Map();
    const rows = await this.base(tx).select(this.summaryColumns()).where('s.id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, this.toSummary(r)]));
  }

  async full(id: string, tx?: Tx): Promise<StudentDto | null> {
    const r = await this.base(tx)
      .select(this.summaryColumns())
      .select([
        's.first_name', 's.middle_names', 's.last_name', 's.date_of_birth', 's.gender', 's.nationality', 's.home_address', 's.previous_school',
        's.admission_date', 's.admission_class_id', 's.admission_year', 's.birth_cert_no', 's.religion', 's.languages', 's.archived_at', 's.archive_reason',
        's.version', 's.created_at', 'e.id as enrolment_id', 'e.start_date', 'e.status as enrolment_status', 'e.reason as enrolment_reason',
        'e.academic_year_id', 'y.name as academic_year_name',
      ])
      .where('s.id', '=', id).executeTakeFirst();
    if (!r) return null;
    return {
      ...this.toSummary(r),
      firstName: r.first_name, middleNames: r.middle_names, lastName: r.last_name, dateOfBirth: r.date_of_birth, gender: r.gender,
      nationality: r.nationality, homeAddress: r.home_address, previousSchool: r.previous_school, admissionDate: r.admission_date,
      admissionClassId: r.admission_class_id, admissionYear: r.admission_year, birthCertNo: r.birth_cert_no, religion: r.religion,
      languages: r.languages, archivedAt: isoInstant(r.archived_at), archiveReason: r.archive_reason, version: r.version, createdAt: isoInstant(r.created_at),
      currentEnrolment: r.enrolment_id ? {
        id: r.enrolment_id, classId: r.class_id!, className: r.class_name!, academicYearId: r.academic_year_id!, academicYear: r.academic_year_name!,
        rollNumber: r.roll_number, startDate: r.start_date!, endDate: null, status: r.enrolment_status!, reason: r.enrolment_reason,
      } : null,
    };
  }
}
