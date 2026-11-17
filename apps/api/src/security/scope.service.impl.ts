import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Db } from '../common/db/database.module';
import type { AuthUser } from './auth-user';
import type { ScopeService } from './scope.service';

/**
 * Object-level scope (IDOR protection).
 * - Any role other than TEACHER: unrestricted (null). Field rules still apply via FieldPolicy.
 * - TEACHER only: classes from staff_class_assignments active today (start_date <= today, end_date null or >= today),
 *   and students with an open enrolment in one of those classes.
 * "Today" is the Africa/Accra date (UTC+0, no daylight saving).
 */
@Injectable()
export class DbScopeService implements ScopeService {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async allowedClassIds(user: AuthUser): Promise<string[] | null> {
    if (user.roles.some((r) => r !== 'TEACHER')) return null;
    if (!user.staffId) return [];
    const rows = await this.db.selectFrom('staff_class_assignments').select('class_id').distinct()
      .where('staff_id', '=', user.staffId)
      .where('start_date', '<=', sql<string>`(now() AT TIME ZONE 'Africa/Accra')::date`)
      .where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', sql<string>`(now() AT TIME ZONE 'Africa/Accra')::date`)]))
      .execute();
    return rows.map((r) => r.class_id);
  }

  async canAccessStudent(user: AuthUser, studentId: string): Promise<boolean> {
    const classes = await this.allowedClassIds(user);
    if (classes === null) return true;
    if (classes.length === 0) return false;
    const row = await this.db.selectFrom('enrolments').select('id')
      .where('student_id', '=', studentId).where('end_date', 'is', null).where('class_id', 'in', classes)
      .executeTakeFirst();
    return Boolean(row);
  }
}
