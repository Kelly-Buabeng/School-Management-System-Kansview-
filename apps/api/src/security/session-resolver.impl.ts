import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../common/app-error';
import { KYSELY, type Db } from '../common/db/database.module';
import type { AuthUser, SessionResolver } from './auth-user';
import { permissionsForRoles, ROLES, type Role } from './permissions';
import { SESSION_COOKIE, SessionService, sessionPhase, type SessionPhase } from './session.service';

/**
 * Extra session facts the PermissionGuard needs but that are not part of the shared AuthUser interface.
 * Attached only by the real resolver; a test override of SESSION_RESOLVER has no state and is treated as a
 * fully signed-in session (CSRF and login-phase checks then do not apply).
 */
export interface SessionState {
  sessionHash: string;
  phase: SessionPhase;
  csrfToken: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
}
const states = new WeakMap<AuthUser, SessionState>();
export function sessionStateOf(user: AuthUser): SessionState | undefined {
  return states.get(user);
}

export function readSessionCookie(req: { headers: Record<string, unknown>; cookies?: Record<string, string> }): string | null {
  const fromParser = req.cookies?.[SESSION_COOKIE];
  if (fromParser) return fromParser;
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

@Injectable()
export class DbSessionResolver implements SessionResolver {
  constructor(@Inject(KYSELY) private readonly db: Db, private readonly sessions: SessionService) {}

  async resolve(req: { headers: Record<string, unknown>; cookies?: Record<string, string> }): Promise<AuthUser | null> {
    const raw = readSessionCookie(req);
    if (!raw) return null;
    const t = await this.sessions.touch(raw);
    if (t.status === 'expired') throw new AppError(401, ErrorCodes.AUTH_SESSION_EXPIRED, 'Your session has ended. Please sign in again.');
    if (t.status !== 'ok') return null;
    const u = await this.db.selectFrom('users')
      .select(['id', 'username', 'full_name', 'roles', 'status', 'staff_id', 'mfa_enabled', 'must_change_password', 'archived_at'])
      .where('id', '=', t.session.user_id).executeTakeFirst();
    if (!u || u.status !== 'active' || u.archived_at) {
      await this.sessions.revoke(t.session.id, 'user not active');
      return null;
    }
    const roles = u.roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
    const phase = sessionPhase({ ...u, roles }, t.session);
    const user: AuthUser = {
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      roles,
      permissions: phase === 'full' ? permissionsForRoles(roles) : new Set(),
      sessionId: t.session.id,
      staffId: u.staff_id,
      mfaVerified: Boolean(t.session.mfa_verified_at),
    };
    states.set(user, { sessionHash: t.session.id, phase, csrfToken: this.sessions.csrfToken(t.session.id), mfaEnabled: u.mfa_enabled, mustChangePassword: u.must_change_password });
    return user;
  }
}
