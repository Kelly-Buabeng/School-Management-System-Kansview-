import type { AuthUser } from './auth-user';

/**
 * Object-level access (IDOR protection). Repositories call these before returning a record by id.
 * Out-of-scope records must surface as 404, not 403.
 * Real implementation: Agent D (uses staff_class_assignments for TEACHER).
 */
export interface ScopeService {
  /** null = no restriction; otherwise the list of class ids the user may see. */
  allowedClassIds(user: AuthUser): Promise<string[] | null>;
  canAccessStudent(user: AuthUser, studentId: string): Promise<boolean>;
}
export const SCOPE_SERVICE = Symbol('SCOPE_SERVICE');
