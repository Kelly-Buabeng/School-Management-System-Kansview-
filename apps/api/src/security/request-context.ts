import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from './auth-user';

/**
 * Per-request context (ip, request id, user agent, signed-in user), available to AuditService and others
 * without threading the request through every call. Set by `requestContextMiddleware` (registered in SecurityModule).
 */
export interface RequestContext {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  user: AuthUser | null;
  /** Audit actions already written during this request (lets @Audited skip duplicates). */
  audited: Set<string>;
}

const als = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return als.getStore();
}

export function runWithRequestContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return als.run({ requestId: null, ip: null, userAgent: null, user: null, audited: new Set(), ...ctx }, fn);
}

/** Normalises IPv4-mapped IPv6 addresses ("::ffff:10.0.0.5" → "10.0.0.5"). */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function requestContextMiddleware(req: Request & { id?: string }, _res: Response, next: NextFunction): void {
  const ua = req.headers['user-agent'];
  als.run(
    { requestId: req.id ?? null, ip: clientIp(req), userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null, user: null, audited: new Set() },
    () => next(),
  );
}
