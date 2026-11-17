export interface StudentBillingInfo {
  studentId: string;
  studentCode: string;
  fullName: string;
  classId: string | null;
  className: string | null;
  levelId: string | null;
  status: string;
  feePayers: Array<{ guardianId: string; fullName: string; phone: string | null }>;
}

/** Read-side student API for finance, notifications and documents. Owner: Agent B. */
export interface StudentLookup {
  getBillingInfo(studentId: string, tx?: unknown): Promise<StudentBillingInfo | null>;
  /** Active students in a class/level/whole school for the given academic year (current if omitted). */
  listActiveStudentIds(scope: { classIds?: string[]; levelIds?: string[]; school?: boolean }, academicYearId?: string): Promise<string[]>;
  /** Guardians who should receive SMS for a student (receives_sms = true, primary first). */
  smsRecipients(studentId: string, primaryOnly: boolean): Promise<Array<{ guardianId: string; phone: string }>>;
}
export const STUDENT_LOOKUP = Symbol('STUDENT_LOOKUP');
