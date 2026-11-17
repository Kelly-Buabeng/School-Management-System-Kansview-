import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error';
import { ErrorCodes } from '@sms/shared';
import { PERMISSION_KEY } from './decorators';
import { SESSION_RESOLVER, type AuthUser, type SessionResolver } from './auth-user';
import type { Permission } from './permissions';

/**
 * Global guard: deny by default.
 * SCAFFOLD VERSION. Agent D hardens it (MFA-pending sessions, CSRF, owner-of-export, etc.) without changing the decorator API.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SESSION_RESOLVER) private readonly sessions: SessionResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, 'This action is not available', 'Route has no permission declaration');
    }
    if (required === 'public') return true;

    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown>; cookies?: Record<string, string>; user?: AuthUser }>();
    const user = await this.sessions.resolve(req);
    if (!user) throw new AppError(401, ErrorCodes.UNAUTHENTICATED, 'Please sign in');
    req.user = user;

    if (required === 'self' || required === 'owner-of-export' || required === 'inherits-from-owning-record') return true;
    if (required === 'mfa-pending-session') return true;
    if (!user.permissions.has(required as Permission)) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, 'You do not have permission to do this');
    }
    return true;
  }
}
