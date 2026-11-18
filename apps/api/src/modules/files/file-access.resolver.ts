// Owner: Agent F.
import { Inject, Injectable } from '@nestjs/common';
import { KYSELY, type Db } from '../../common/db/database.module';
import { SCOPE_SERVICE, type AuthUser, type Permission, type ScopeService } from '../../security';

/**
 * GET /files/{id} has x-permission `inherits-from-owning-record`: the right to download a file is the right to read
 * the record that owns it. Each owner kind maps to the permission required and, for student-bound records,
 * to the student whose scope (SCOPE_SERVICE) must include the user.
 */
export type FileOwnerKind =
  | 'student_document' | 'student_photo' | 'pickup_photo' | 'report_card' | 'transfer_letter'
  | 'payment_evidence' | 'school_logo' | 'import_file' | 'dsr_response' | 'export' | string;

export interface FileOwner {
  kind: FileOwnerKind;
  /** Permission needed to read the owning record; null = any signed-in user (e.g. the school logo). */
  permission: Permission | null;
  /** Student the owning record belongs to; access also requires SCOPE_SERVICE.canAccessStudent. */
  studentId?: string | null;
  /** When set, only this user may download (owner-of-export style). */
  ownerUserId?: string | null;
}

/** Finds the records that own a file. Other modules (e.g. exports) can register more lookups at start-up. */
export type FileOwnerLookup = (db: Db, fileId: string) => Promise<FileOwner[]>;

const BUILT_IN: FileOwnerLookup[] = [
  async (db, id) => (await db.selectFrom('student_documents').select('student_id').where('file_id', '=', id).execute())
    .map((r) => ({ kind: 'student_document', permission: 'student_documents:read', studentId: r.student_id })),
  async (db, id) => (await db.selectFrom('students').select('id').where('photo_file_id', '=', id).execute())
    .map((r) => ({ kind: 'student_photo', permission: 'students:read', studentId: r.id })),
  async (db, id) => (await db.selectFrom('authorised_pickups').select('student_id').where('photo_file_id', '=', id).execute())
    .map((r) => ({ kind: 'pickup_photo', permission: 'pickups:read', studentId: r.student_id })),
  async (db, id) => (await db.selectFrom('report_cards').select('student_id').where('pdf_file_id', '=', id).execute())
    .map((r) => ({ kind: 'report_card', permission: 'academics:read', studentId: r.student_id })),
  async (db, id) => (await db.selectFrom('withdrawals').select('student_id').where('transfer_letter_file_id', '=', id).execute())
    .map((r) => ({ kind: 'transfer_letter', permission: 'withdrawals:read', studentId: r.student_id })),
  async (db, id) => (await db.selectFrom('payments').select('student_id').where('attachment_file_id', '=', id).execute())
    .map((r) => ({ kind: 'payment_evidence', permission: 'payments:read', studentId: r.student_id })),
  async (db, id) => (await db.selectFrom('school_profile').select('id').where('logo_file_id', '=', id).execute())
    .map(() => ({ kind: 'school_logo', permission: null })),
  async (db, id) => (await db.selectFrom('import.jobs').select('id')
    .where((eb) => eb.or([eb('file_id', '=', id), eb('dry_run_report_file_id', '=', id), eb('error_report_file_id', '=', id)])).execute())
    .map(() => ({ kind: 'import_file', permission: 'imports:read' })),
  async (db, id) => (await db.selectFrom('data_subject_requests').select('student_id').where('response_file_id', '=', id).execute())
    .map(() => ({ kind: 'dsr_response', permission: 'dpa:read' })),
];

@Injectable()
export class FileAccessResolver {
  private readonly lookups: FileOwnerLookup[] = [...BUILT_IN];

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
  ) {}

  /** e.g. an exports module: `resolver.register(async (db, id) => [{ kind: 'export', permission: null, ownerUserId }])`. */
  register(lookup: FileOwnerLookup): void {
    this.lookups.push(lookup);
  }

  async owners(fileId: string): Promise<FileOwner[]> {
    const all = await Promise.all(this.lookups.map((l) => l(this.db, fileId)));
    return all.flat();
  }

  /**
   * Returns the owner that grants access, or null. A file with no owning record is only available to the user who
   * uploaded it (e.g. an attachment not yet linked to its record).
   */
  async authorise(user: AuthUser, fileId: string, uploadedBy: string | null): Promise<FileOwner | null> {
    const owners = await this.owners(fileId);
    if (owners.length === 0) {
      return uploadedBy && uploadedBy === user.id ? { kind: 'unlinked_upload', permission: null } : null;
    }
    for (const o of owners) {
      if (o.permission && !user.permissions.has(o.permission)) continue;
      if (o.ownerUserId && o.ownerUserId !== user.id) continue;
      if (o.studentId && !(await this.scope.canAccessStudent(user, o.studentId))) continue;
      return o;
    }
    return null;
  }
}
