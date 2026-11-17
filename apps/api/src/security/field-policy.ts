import type { AuthUser } from './auth-user';

export type PolicyResource = 'student' | 'guardian' | 'staff' | 'medical' | 'incident' | 'student_finance';

/** Removes fields the user may not see from a response DTO (see rbac.md "Field-level rules"). Real implementation: Agent D. */
export interface FieldPolicy {
  apply<T extends Record<string, unknown>>(resource: PolicyResource, dto: T, user: AuthUser): Partial<T>;
}
export const FIELD_POLICY = Symbol('FIELD_POLICY');
