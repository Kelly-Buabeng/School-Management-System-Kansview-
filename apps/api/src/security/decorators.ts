import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, SpecialAccess } from './permissions';
import type { AuthUser } from './auth-user';

export const PERMISSION_KEY = 'sms:permission';
export const AUDIT_KEY = 'sms:audit';

/** Required on every route (or @Public / @Access). A route without one is denied and fails the RBAC coverage test. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
export const Public = () => SetMetadata(PERMISSION_KEY, 'public' satisfies SpecialAccess);
/** For 'self', 'mfa-pending-session', 'owner-of-export', 'inherits-from-owning-record' routes. */
export const Access = (access: Exclude<SpecialAccess, 'public'>) => SetMetadata(PERMISSION_KEY, access);

/** Marks a route whose successful execution always writes an audit event (see x-audit in the OpenAPI spec). */
export const Audited = (action: string, entityType: string) => SetMetadata(AUDIT_KEY, { action, entityType });

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  if (!req.user) throw new Error('CurrentUser used on a route without authentication');
  return req.user;
});
