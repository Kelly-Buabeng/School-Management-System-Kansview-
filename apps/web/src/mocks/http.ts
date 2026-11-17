/**
 * Mock server plumbing: session, permission checks, CSRF, idempotency, problem+json, network flake simulation.
 */
import { delay, http, HttpResponse, type DefaultBodyType, type HttpResponseResolver, type PathParams, type StrictRequest } from 'msw';
import { permissionsForRoles } from '@/auth/permissions';
import { getDb, uid, type MUser } from './db';
import { mockControl } from './control';

export const BASE = '*/api/v1';

// ---------- session (simulates the HttpOnly cookie) ----------
interface Session {
  userId: string;
  stage: 'mfa_pending' | 'active';
  csrf: string;
}
const SESSION_KEY = 'sms-mock-session';
let session: Session | null = null;
try {
  const raw = globalThis.sessionStorage?.getItem(SESSION_KEY);
  if (raw) session = JSON.parse(raw) as Session;
} catch {
  session = null;
}
export function getSession() {
  return session;
}
export function setSession(s: Session | null) {
  session = s;
  try {
    if (s) globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(s));
    else globalThis.sessionStorage?.removeItem(SESSION_KEY);
  } catch {
    // sessionStorage unavailable (private mode); the mock session then lasts until reload.
  }
}
export function newCsrf() {
  return `csrf-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function currentUser(): MUser | null {
  if (!session || session.stage !== 'active') return null;
  return getDb().users.find((u) => u.id === session!.userId) ?? null;
}

export function permsOf(user: MUser) {
  return new Set(permissionsForRoles(user.roles));
}

export function meOf(user: MUser) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    roles: user.roles,
    permissions: permissionsForRoles(user.roles),
    csrfToken: session?.csrf ?? '',
    mfaEnabled: user.mfaEnabled,
    mustChangePassword: user.mustChangePassword,
  };
}

// ---------- problem+json ----------
export function problem(status: number, code: string, title: string, extra: { detail?: string; errors?: { field: string; code: string; message: string }[]; meta?: Record<string, unknown> } = {}) {
  return HttpResponse.json(
    { type: `https://sms.local/errors/${code.toLowerCase().replace(/_/g, '-')}`, title, status, code, requestId: `mock-${uid().slice(-8)}`, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}
export const notFound = (what = 'record') => problem(404, 'NOT_FOUND', `We could not find that ${what}.`);
export const validation = (errors: { field: string; message: string }[], title = 'Please check the highlighted fields.') =>
  problem(400, 'VALIDATION_FAILED', title, { errors: errors.map((e) => ({ ...e, code: 'INVALID' })) });

// ---------- audit ----------
export function audit(user: MUser | null, action: string, entityType: string, summaryText: string, entityId?: string) {
  getDb().audit.unshift({ id: uid(), at: new Date().toISOString(), actorName: user?.fullName ?? 'Unknown', action, entityType, entityId, summary: summaryText, ip: '192.168.1.20' });
}

// ---------- route builder ----------
type Access = string | 'public' | 'self' | 'mfa-pending-session';
interface Ctx<P extends PathParams> {
  request: StrictRequest<DefaultBodyType>;
  params: P;
  user: MUser;
  perms: Set<string>;
  body: <T = Record<string, unknown>>() => Promise<T>;
  query: URLSearchParams;
}
interface RouteOptions {
  idempotent?: boolean;
}
type Resolver<P extends PathParams> = (ctx: Ctx<P>) => Response | Promise<Response>;

const CSRF_EXEMPT = ['/auth/login', '/auth/mfa/verify', '/auth/password/reset-request', '/auth/password/reset'];

function route<P extends PathParams = PathParams>(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, access: Access, resolver: Resolver<P>, opts: RouteOptions = {}) {
  const handler: HttpResponseResolver<P> = async ({ request, params }) => {
    if (mockControl.latencyMs) await delay(mockControl.latencyMs);
    if (mockControl.mode === 'slow') await delay(4000);
    if (mockControl.mode === 'offline') return HttpResponse.error();
    const isWrite = method !== 'get';

    const user = currentUser();
    if (access !== 'public' && access !== 'mfa-pending-session') {
      if (!user) return problem(401, session ? 'AUTH_SESSION_EXPIRED' : 'UNAUTHENTICATED', 'Please sign in again. Your session has ended.');
      if (isWrite && !CSRF_EXEMPT.includes(path) && request.headers.get('X-CSRF-Token') !== session?.csrf) {
        return problem(403, 'CSRF_INVALID', 'Your page is out of date. Please reload and try again.');
      }
    }
    const perms = user ? permsOf(user) : new Set<string>();
    if (access !== 'public' && access !== 'self' && access !== 'mfa-pending-session' && !perms.has(access)) {
      return problem(403, 'FORBIDDEN', 'You do not have permission to do this.', { detail: `This needs the "${access}" permission. Ask the administrator if you need it.` });
    }

    let cachedBody: unknown;
    let bodyRead = false;
    const readBody = async <T,>() => {
      if (!bodyRead) {
        bodyRead = true;
        const text = await request.clone().text();
        cachedBody = text ? JSON.parse(text) : {};
      }
      return cachedBody as T;
    };

    let idemKey: string | null = null;
    let idemHash = '';
    if (opts.idempotent) {
      idemKey = request.headers.get('Idempotency-Key');
      if (!idemKey || idemKey.length < 16) return problem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This save needs an Idempotency-Key header.');
      idemHash = `${method} ${path} ${JSON.stringify(params)} ${JSON.stringify(await readBody())}`;
      const prev = getDb().idempotency.get(idemKey);
      if (prev) {
        if (prev.bodyHash !== idemHash) {
          return problem(422, 'IDEMPOTENCY_KEY_REUSED', 'This form was already used for a different save. Open a new form and try again.');
        }
        return HttpResponse.json(prev.body as Record<string, unknown>, { status: prev.status, headers: { 'Idempotent-Replayed': 'true' } });
      }
    }

    const res = await resolver({ request, params: params as P, user: user as MUser, perms, body: readBody, query: new URL(request.url).searchParams });

    if (opts.idempotent && idemKey && res.status < 500 && res.status !== 409) {
      const body = await res.clone().json().catch(() => null);
      getDb().idempotency.set(idemKey, { bodyHash: idemHash, status: res.status, body });
    }
    if (isWrite && mockControl.mode === 'lose-next-save' && res.status < 400) {
      // The server stored it, but the reply is "lost" on the way back.
      mockControl.setMode('normal');
      return HttpResponse.error();
    }
    return res;
  };
  return http[method](`${BASE}${path.replace(/\{(\w+)\}/g, ':$1')}`, handler);
}

export const r = {
  get: <P extends PathParams = PathParams>(path: string, access: Access, fn: Resolver<P>, opts?: RouteOptions) => route<P>('get', path, access, fn, opts),
  post: <P extends PathParams = PathParams>(path: string, access: Access, fn: Resolver<P>, opts?: RouteOptions) => route<P>('post', path, access, fn, opts),
  put: <P extends PathParams = PathParams>(path: string, access: Access, fn: Resolver<P>, opts?: RouteOptions) => route<P>('put', path, access, fn, opts),
  patch: <P extends PathParams = PathParams>(path: string, access: Access, fn: Resolver<P>, opts?: RouteOptions) => route<P>('patch', path, access, fn, opts),
  delete: <P extends PathParams = PathParams>(path: string, access: Access, fn: Resolver<P>, opts?: RouteOptions) => route<P>('delete', path, access, fn, opts),
};

export function json(body: unknown, status = 200) {
  return HttpResponse.json(body as Record<string, unknown>, { status });
}
export function noContent() {
  return new HttpResponse(null, { status: 204 });
}

export function paginate<T>(items: T[], query: URLSearchParams) {
  const page = Math.max(1, Number(query.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') ?? 25)));
  return { data: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length };
}

/** A tiny valid PDF with text lines (receipts, letters, reports in mock mode). */
export function fakePdf(title: string, lines: string[]) {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const content = [`BT /F1 16 Tf 50 790 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 11 Tf 50 ${760 - i * 16} Td (${esc(l)}) Tj ET`)].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new HttpResponse(out, { headers: { 'Content-Type': 'application/pdf' } });
}

export function fakeFile(name: string, text: string, type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  return new HttpResponse(text, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` } });
}
