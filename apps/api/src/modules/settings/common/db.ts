// Owner: Agent B. Database helpers shared by Agent B's modules.
import { sql } from 'kysely';

/** `date` columns come back as 'YYYY-MM-DD' strings at runtime (type parser in DatabaseModule); generated types say Date. */
export function isoDate(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

/** timestamptz → ISO string (UTC, with Z). */
export function isoInstant(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (typeof v === 'string' ? new Date(v) : v).toISOString();
}

/** numeric columns come back as strings. */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

interface PgError { code?: string; constraint?: string; detail?: string }
const pgErr = (e: unknown): PgError => (e && typeof e === 'object' ? (e as PgError) : {});

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const p = pgErr(e);
  return p.code === '23505' && (!constraint || p.constraint === constraint);
}
export function isExclusionViolation(e: unknown, constraint?: string): boolean {
  const p = pgErr(e);
  return p.code === '23P01' && (!constraint || p.constraint === constraint);
}
export function isFkViolation(e: unknown): boolean {
  return pgErr(e).code === '23503';
}
export function isCheckViolation(e: unknown): boolean {
  return pgErr(e).code === '23514';
}
export function constraintOf(e: unknown): string | undefined {
  return pgErr(e).constraint;
}

/** DB status 'graduated' is shown as 'alumni' in the API (OpenAPI StudentStatus). */
export type ApiStudentStatus = 'applicant' | 'active' | 'withdrawn' | 'transferred_out' | 'alumni' | 'deceased';
export type DbStudentStatus = 'applicant' | 'active' | 'withdrawn' | 'transferred_out' | 'graduated' | 'deceased';
export function apiStatus(s: DbStudentStatus | string): ApiStudentStatus {
  return (s === 'graduated' ? 'alumni' : s) as ApiStudentStatus;
}
export function dbStatus(s: ApiStudentStatus | string): DbStudentStatus {
  return (s === 'alumni' ? 'graduated' : s) as DbStudentStatus;
}

/** SQL fragment: full name "First Middle Last" of an aliased students/guardians/staff row. */
export function fullNameSql(alias: string) {
  return sql<string>`concat_ws(' ', ${sql.ref(`${alias}.first_name`)}, nullif(${sql.ref(`${alias}.middle_names`)}, ''), ${sql.ref(`${alias}.last_name`)})`;
}
export function guardianNameSql(alias: string) {
  return sql<string>`concat_ws(' ', ${sql.ref(`${alias}.first_name`)}, ${sql.ref(`${alias}.last_name`)})`;
}
