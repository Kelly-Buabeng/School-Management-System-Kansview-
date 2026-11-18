import { createHash } from 'node:crypto';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import type { ScopeService } from '../../security/scope.service';
import type { AuthUser } from '../../security/auth-user';

/** PostgreSQL error with a SQLSTATE code. */
export function pgCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined;
}
export function pgConstraint(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'constraint' in e ? String((e as { constraint: unknown }).constraint) : undefined;
}
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  return pgCode(e) === '23505' && (constraint === undefined || pgConstraint(e) === constraint);
}

/** Stable hash of a request body (keys sorted) for idempotency comparisons. */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function requireIdempotencyKey(key: string | undefined): string {
  if (!key || key.trim() === '') throw new AppError(400, ErrorCodes.IDEMPOTENCY_KEY_REQUIRED, 'Missing Idempotency-Key header', 'Refresh the form and try again.');
  const k = key.trim();
  if (k.length < 16 || k.length > 128) {
    throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Some fields need attention', 'Idempotency-Key must be 16 to 128 characters.', [
      { field: 'Idempotency-Key', code: 'INVALID', message: 'Must be 16 to 128 characters' },
    ]);
  }
  return k;
}

/** Object-level access: out of scope looks exactly like not found. */
export async function assertStudentInScope(scope: ScopeService, user: AuthUser, studentId: string): Promise<void> {
  if (!(await scope.canAccessStudent(user, studentId))) throw AppError.notFound('student');
}

export function fullName(first: string, middle: string | null | undefined, last: string): string {
  return [first, middle, last].filter((x) => x && x.trim() !== '').join(' ');
}
