import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

/**
 * API-specific hardening on top of the default helmet() in bootstrap.ts.
 * The API only serves JSON and file downloads, so the CSP forbids everything; the web app's own CSP is set by Caddy.
 */
const strictHelmet = helmet({
  contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  frameguard: { action: 'deny' },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
});

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  strictHelmet(req, res, (err?: unknown) => {
    if (err) return next(err);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.removeHeader('X-Powered-By');
    next();
  });
}
