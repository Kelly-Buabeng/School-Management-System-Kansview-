import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';
import { AUDIT_KEY } from './decorators';
import { AUDIT_SERVICE, type AuditAction, type AuditService } from './audit.service';
import type { AuthUser } from './auth-user';
import { currentRequestContext } from './request-context';

/**
 * Global interceptor for @Audited(action, entityType): after a successful handler, writes the audit event
 * unless the handler already recorded the same action/entity itself (preferred, because the handler can
 * do it inside its transaction with field-level changes).
 * entityId comes from the `id` route param or the response `id`; studentId from `/students/:id` routes
 * or a `studentId` in the response.
 */
@Injectable()
export class AuditedInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, @Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<{ action: string; entityType: string } | undefined>(AUDIT_KEY, ctx.getHandler());
    if (!meta || ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<{ params?: Record<string, string>; route?: { path?: string }; user?: AuthUser; body?: { reason?: unknown } }>();
    return next.handle().pipe(
      mergeMap((result) =>
        from((async () => {
          const rc = currentRequestContext();
          if (rc?.audited.has(`${meta.action}:${meta.entityType}`)) return result;
          const body = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
          const params = req.params ?? {};
          const isStudentRoute = /\/students\/:id\b/.test(req.route?.path ?? '');
          await this.audit.record({
            action: meta.action as AuditAction,
            entityType: meta.entityType,
            entityId: params.id ?? (typeof body.id === 'string' ? body.id : null),
            studentId: isStudentRoute ? params.id ?? null : typeof body.studentId === 'string' ? body.studentId : null,
            reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null,
          }, req.user ?? null);
          return result;
        })()),
      ),
    );
  }
}
