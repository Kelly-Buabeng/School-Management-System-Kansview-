import { Inject, Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error';
import { ErrorCodes } from '@sms/shared';
import { PERMISSION_KEY } from './decorators';
import { SESSION_RESOLVER, type AuthUser, type SessionResolver } from './auth-user';
import type { Permission } from './permissions';
import { LOGIN_PHASE_KEY } from './login-phase.decorator';
import { sessionStateOf } from './session-resolver.impl';
import { SessionService, type SessionPhase } from './session.service';
import { currentRequestContext } from './request-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: deny by default.
 * 1. Route must declare @RequirePermission / @Public / @Access (else 403, and the RBAC coverage test fails).
 * 2. Signed-in session required for everything except @Public.
 * 3. CSRF synchroniser token (X-CSRF-Token) on every non-GET request of a real session.
 * 4. Part-way sessions (MFA pending, MFA enrolment required, temporary password) only reach routes marked
 *    @AllowDuringLogin(...) (or 'mfa-pending-session' for the MFA code step).
 * 5. RBAC permission check. Object-level scope is applied by repositories via ScopeService (404 when out of scope).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SESSION_RESOLVER) private readonly sessions: SessionResolver,
    @Optional() private readonly sessionService?: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, targets);
    if (!required) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, 'This action is not available', 'Route has no permission declaration');
    }
    if (required === 'public') return true;

    const req = ctx.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown>; cookies?: Record<string, string>; user?: AuthUser }>();
    const user = await this.sessions.resolve(req);
    if (!user) throw new AppError(401, ErrorCodes.UNAUTHENTICATED, 'Please sign in');
    req.user = user;
    const rc = currentRequestContext();
    if (rc) rc.user = user;

    const state = sessionStateOf(user);
    if (state) {
      if (!SAFE_METHODS.has(req.method.toUpperCase())) {
        if (!this.sessionService?.verifyCsrf(state.sessionHash, req.headers['x-csrf-token'])) {
          throw new AppError(403, ErrorCodes.CSRF_INVALID, 'Your page is out of date. Please refresh and try again.');
        }
      }
      if (state.phase !== 'full') {
        const phases = this.reflector.getAllAndOverride<SessionPhase[] | undefined>(LOGIN_PHASE_KEY, targets) ?? [];
        const allowed = required === 'mfa-pending-session' ? state.phase === 'mfa_pending' : phases.includes(state.phase);
        if (!allowed) throw phaseError(state.phase);
      }
    }

    if (required === 'self' || required === 'owner-of-export' || required === 'inherits-from-owning-record' || required === 'mfa-pending-session') return true;
    if (!user.permissions.has(required as Permission)) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, 'You do not have permission to do this');
    }
    return true;
  }
}

function phaseError(phase: SessionPhase): AppError {
  switch (phase) {
    case 'mfa_pending':
      return new AppError(401, ErrorCodes.AUTH_MFA_REQUIRED, 'Enter the 6-digit code from your authenticator app');
    case 'mfa_enrolment':
      return new AppError(403, ErrorCodes.AUTH_MFA_ENROLMENT_REQUIRED, 'Set up two-step sign-in before continuing',
        'Your role needs an authenticator app on your phone. Follow the set-up steps on screen.');
    default:
      return new AppError(403, ErrorCodes.FORBIDDEN, 'Please change your temporary password first', undefined, undefined, { mustChangePassword: true });
  }
}
