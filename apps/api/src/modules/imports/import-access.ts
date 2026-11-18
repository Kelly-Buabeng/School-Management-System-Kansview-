import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../security';
import { IMPORT_TYPES, type ImportType } from './import-columns';

/**
 * Which import types a user may work with (docs/contracts/rbac.md, "Bulk import"):
 * - ADMIN: all types, and the only role that can commit (imports:commit).
 * - REGISTRAR: students and guardians (create + validate).
 * - BURSAR: opening balances only (create + validate); commit needs ADMIN.
 * Jobs of other types are invisible (404), so ids cannot be probed.
 */
export function allowedImportTypes(user: AuthUser): Set<ImportType> {
  if (user.roles.includes('ADMIN')) return new Set(IMPORT_TYPES);
  const out = new Set<ImportType>();
  if (user.roles.includes('REGISTRAR')) out.add('students_guardians');
  if (user.roles.includes('BURSAR')) out.add('opening_balances');
  return out;
}

export function assertTypeAllowed(user: AuthUser, type: ImportType): void {
  if (!allowedImportTypes(user).has(type)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'You cannot import this kind of data',
      type === 'opening_balances' ? 'Only the bursar or the administrator can import opening balances.' : 'Ask the administrator to do this import.',
    );
  }
}

/** Opening balances post to the fee ledger: commit is ADMIN only (rbac.md). */
export function assertCanCommit(user: AuthUser, type: ImportType): void {
  if (type === 'opening_balances' && !user.roles.includes('ADMIN')) {
    throw new AppError(403, 'FORBIDDEN', 'Only the administrator can commit opening balances');
  }
}
