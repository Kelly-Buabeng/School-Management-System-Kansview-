/**
 * API client. Uses openapi-fetch with the generated `paths` type from @sms/contracts, so every path used here
 * must exist in packages/contracts/openapi.yaml (compile-time check against contract drift).
 *
 * - Same-origin `/api/v1`, cookies included (session cookie is HttpOnly; nothing is stored in localStorage).
 * - State-changing requests carry `X-CSRF-Token` (token comes from GET /auth/me).
 * - Errors are thrown as ApiError (problem+json) or NetworkError (server not reached / no answer).
 */
import createClient from 'openapi-fetch';
import type { PathsWithMethod } from 'openapi-typescript-helpers';
import type { paths } from '@sms/contracts';
import type { Problem } from './types';
import { networkStatus } from '@/lib/network';

export const API_MODE: 'mock' | 'real' =
  (import.meta.env.VITE_API_MODE as 'mock' | 'real' | undefined) ?? (import.meta.env.DEV ? 'mock' : 'real');

const API_PREFIX = '/api/v1';
export const apiBase = () => `${globalThis.location?.origin ?? 'http://localhost'}${API_PREFIX}`;

/** Requests that get no answer within this time are treated as "not sure what happened". */
const REQUEST_TIMEOUT_MS = 30_000;

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null | undefined) {
  csrfToken = token ?? null;
}

type UnauthorisedListener = (problem: Problem) => void;
const unauthorisedListeners = new Set<UnauthorisedListener>();
/** Called when any non-auth request returns 401 (session ended / expired). */
export function onUnauthorised(fn: UnauthorisedListener) {
  unauthorisedListeners.add(fn);
  return () => {
    unauthorisedListeners.delete(fn);
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }
  get code() {
    return this.problem.code;
  }
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.field] = e.message;
    return out;
  }
}

/** The request may or may not have reached the server. Never assume it failed. */
export class NetworkError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.name = 'NetworkError';
    this.timedOut = timedOut;
  }
}

const client = createClient<paths>({
  baseUrl: apiBase(),
  credentials: 'include',
  // Resolve fetch lazily so test interceptors (MSW) installed after import still apply.
  fetch: (req: Request) => globalThis.fetch(req),
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type PathFor<M extends Method> = PathsWithMethod<paths, M> & string;

export interface RequestOptions {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  ifMatch?: string | number;
  signal?: AbortSignal;
}

function cleanQuery(q: RequestOptions['query']) {
  if (!q) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

function toProblem(status: number, body: unknown): Problem {
  if (body && typeof body === 'object' && 'title' in body) {
    const b = body as Partial<Problem>;
    return {
      type: b.type ?? 'about:blank',
      title: b.title ?? 'Something went wrong',
      status: b.status ?? status,
      code: b.code ?? 'INTERNAL_ERROR',
      requestId: b.requestId ?? '',
      detail: b.detail,
      errors: b.errors,
      meta: b.meta,
    };
  }
  return {
    type: 'about:blank',
    title: status >= 500 ? 'The server had a problem. Please try again.' : 'The request could not be completed.',
    status,
    code: status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN',
    requestId: '',
  };
}

const AUTH_PATHS = ['/auth/login', '/auth/mfa/verify', '/auth/me', '/auth/password/reset-request', '/auth/password/reset'];

async function call<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (method !== 'get' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers['If-Match'] = String(opts.ifMatch);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? anySignal([opts.signal, timeout.signal]) : timeout.signal;

  let result: { data?: unknown; error?: unknown; response: Response };
  try {
    const fn = (client as unknown as Record<string, (p: string, init: unknown) => Promise<typeof result>>)[method.toUpperCase()]!;
    result = await fn(path, {
      params: { path: opts.path, query: cleanQuery(opts.query) },
      body: opts.body,
      headers,
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // caller cancelled (e.g. typing in search): not a network problem
    networkStatus.reportFailure();
    const timedOut = timeout.signal.aborted;
    throw new NetworkError(
      timedOut ? 'The server did not answer in time.' : 'Could not reach the server. Check the network connection.',
      timedOut,
    );
  } finally {
    clearTimeout(timer);
  }
  networkStatus.reportSuccess();
  const { response } = result;
  if (!response.ok) {
    const problem = toProblem(response.status, result.error);
    if (response.status === 401 && !AUTH_PATHS.includes(path)) for (const l of unauthorisedListeners) l(problem);
    throw new ApiError(problem);
  }
  return result.data as T;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export const api = {
  get: <T>(path: PathFor<'get'>, opts?: RequestOptions) => call<T>('get', path, opts),
  post: <T>(path: PathFor<'post'>, opts?: RequestOptions) => call<T>('post', path, opts),
  put: <T>(path: PathFor<'put'>, opts?: RequestOptions) => call<T>('put', path, opts),
  patch: <T>(path: PathFor<'patch'>, opts?: RequestOptions) => call<T>('patch', path, opts),
  delete: <T>(path: PathFor<'delete'>, opts?: RequestOptions) => call<T>('delete', path, opts),
};

/** Fill `{id}` style path parameters for raw requests (uploads, file downloads). */
export function fillPath(path: string, params: Record<string, string | number> = {}) {
  return path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(params[k] ?? '')));
}

/** Multipart upload (openapi-fetch is JSON-first, so uploads use fetch directly). */
export async function upload<T>(
  method: 'POST' | 'PUT',
  path: PathFor<'post'> | PathFor<'put'>,
  params: Record<string, string | number>,
  form: FormData,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await globalThis.fetch(`${apiBase()}${fillPath(path, params)}`, { method, body: form, headers, credentials: 'include' });
  } catch {
    networkStatus.reportFailure();
    throw new NetworkError('Could not reach the server. The file was not uploaded.');
  }
  networkStatus.reportSuccess();
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(toProblem(res.status, body));
  return body as T;
}

/** Download a file (PDF/XLSX) with the session cookie and open or save it. */
export async function downloadFile(path: PathFor<'get'>, params: Record<string, string | number> = {}, query: Record<string, string> = {}, fileName?: string) {
  const qs = new URLSearchParams(query).toString();
  let res: Response;
  try {
    res = await globalThis.fetch(`${apiBase()}${fillPath(path, params)}${qs ? `?${qs}` : ''}`, { credentials: 'include' });
  } catch {
    networkStatus.reportFailure();
    throw new NetworkError('Could not reach the server to download the file.');
  }
  if (!res.ok) throw new ApiError(toProblem(res.status, await res.json().catch(() => undefined)));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  if (fileName) a.download = fileName;
  else a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}
