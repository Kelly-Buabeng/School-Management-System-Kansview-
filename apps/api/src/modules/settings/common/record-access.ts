// Owner: Agent B. Object-level access for Agent B's /:id routes. Out of scope or missing → 404 (never 403).
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../../common/db/database.module';
import { SCOPE_SERVICE, type ScopeService } from '../../../security/scope.service';
import type { AuthUser } from '../../../security/auth-user';
import { parseId } from './http';

@Injectable()
export class RecordAccess {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
  ) {}

  /** Returns the student's id/status when it exists, is not archived (unless allowed) and is in the user's scope. */
  async student(user: AuthUser, rawId: string, opts: { includeArchived?: boolean; tx?: Tx } = {}): Promise<{ id: string; status: string; archived: boolean }> {
    const id = parseId(rawId, 'student');
    const row = await (opts.tx ?? this.db)
      .selectFrom('students')
      .select(['id', 'status', 'archived_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || (row.archived_at && !opts.includeArchived)) throw AppError.notFound('student');
    if (!(await this.scope.canAccessStudent(user, id))) throw AppError.notFound('student');
    return { id: row.id, status: row.status, archived: !!row.archived_at };
  }

  /** null = every class; otherwise the class ids the user may see (TEACHER: assigned classes). */
  allowedClassIds(user: AuthUser): Promise<string[] | null> {
    return this.scope.allowedClassIds(user);
  }

  async classInScope(user: AuthUser, rawId: string, tx?: Tx): Promise<{ id: string; academicYearId: string; levelId: string; capacity: number | null; displayName: string }> {
    const id = parseId(rawId, 'class');
    const row = await (tx ?? this.db)
      .selectFrom('classes')
      .select(['id', 'academic_year_id', 'level_id', 'capacity', 'display_name'])
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw AppError.notFound('class');
    const allowed = await this.scope.allowedClassIds(user);
    if (allowed && !allowed.includes(id)) throw AppError.notFound('class');
    return { id: row.id, academicYearId: row.academic_year_id, levelId: row.level_id, capacity: row.capacity, displayName: row.display_name };
  }
}
