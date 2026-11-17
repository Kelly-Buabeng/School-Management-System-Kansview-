export interface ImportStudentRow {
  firstName: string;
  middleNames?: string;
  lastName: string;
  preferredName?: string;
  dateOfBirth: string;
  gender: 'male' | 'female';
  admissionDate: string;
  admissionYear?: number;
  classId: string;
  previousSchool?: string;
  homeAddress?: string;
  nationality?: string;
  religion?: string;
  languages?: string[];
  medical?: { allergies?: string; chronicConditions?: string; bloodGroup?: string; alertSummary?: string };
  guardians: Array<{
    existingGuardianId?: string;
    firstName: string;
    lastName: string;
    relationship: string;
    phonePrimary: string;
    phoneSecondary?: string;
    whatsappNumber?: string;
    email?: string;
    occupation?: string;
    isPrimary: boolean;
    isFeePayer: boolean;
    canPickUp: boolean;
  }>;
  /** Existing permanent code from the old system, kept in notes; a new code is always generated. */
  legacyId?: string;
}

/** Writes one validated import row through the same rules as manual admission. Owner: Agent B. Consumer: Agent G. */
export interface ImportTarget {
  upsertStudentWithGuardians(row: ImportStudentRow, tx: unknown, actorUserId: string): Promise<{ studentId: string; studentCode: string; guardianIds: string[] }>;
}
export const IMPORT_TARGET = Symbol('IMPORT_TARGET');
