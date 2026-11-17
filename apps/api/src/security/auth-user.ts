import type { Permission, Role } from './permissions';

/** The authenticated principal attached to every request (request.user). */
export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  roles: Role[];
  permissions: ReadonlySet<Permission>;
  sessionId: string;
  /** staff.id when the user is a member of staff (TEACHER scope). */
  staffId: string | null;
  mfaVerified: boolean;
}

/** Resolves the user from the request (session cookie). Real implementation: Agent D. */
export interface SessionResolver {
  resolve(req: { headers: Record<string, unknown>; cookies?: Record<string, string> }): Promise<AuthUser | null>;
}
export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');
