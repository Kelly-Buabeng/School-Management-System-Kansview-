// Owner: Agent B. Small request helpers shared by Agent B's modules.
import { z } from 'zod';
import { ErrorCodes, isIsoDate, normaliseGhanaPhone } from '@sms/shared';
import { AppError } from '../../../common/app-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids that are not UUIDs can never match a record: answer 404 (same as out of scope). */
export function parseId(value: string, what = 'record'): string {
  if (!UUID_RE.test(value)) throw AppError.notFound(what);
  return value.toLowerCase();
}

/** Reads `If-Match` (accepts `3`, `"3"`, `W/"3"`). Missing → 428; garbage → 412. */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header === '') {
    throw new AppError(428, ErrorCodes.PRECONDITION_REQUIRED, 'This record changed format: please reload and try again', 'The If-Match header with the record version is required.');
  }
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!m) throw versionConflict();
  return Number(m[1]);
}

/** Like parseIfMatch but for opaque string ETags (e.g. settings hash). */
export function parseIfMatchTag(header: string | undefined): string {
  if (header === undefined || header === '') {
    throw new AppError(428, ErrorCodes.PRECONDITION_REQUIRED, 'Please reload and try again', 'The If-Match header is required.');
  }
  return header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

export function versionConflict(): AppError {
  return new AppError(412, ErrorCodes.VERSION_CONFLICT, 'Someone else changed this record', 'Reload the page to see the latest version, then make your change again.');
}

// ---------- Zod building blocks ----------
export const zUuid = z.string().regex(UUID_RE, 'Must be a valid id');
export const zDate = z.string().refine(isIsoDate, 'Use the date format YYYY-MM-DD');
export const zText = (max: number) => z.string().trim().min(1).max(max);
export const zOptText = (max: number) => z.string().trim().max(max).optional();
export const zNullableText = (max: number) => z.string().trim().max(max).nullable().optional();
/** Accepts 024…, +233…, 233…; outputs E.164. */
export const zGhanaPhone = z.string().trim().transform((v, ctx) => {
  const n = normaliseGhanaPhone(v);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid Ghana phone number, e.g. 024 123 4567' });
    return z.NEVER;
  }
  return n;
});
export const zBoolQuery = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export function fullName(p: { first_name: string; middle_names?: string | null; last_name: string }): string {
  return [p.first_name, p.middle_names, p.last_name].filter((x) => x && String(x).trim()).join(' ');
}

/** "+233241234567" → "tel:+233241234567" */
export function telLink(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, '')}`;
}

/** Last 4 characters of a normalised Ghana Card number ("GHA-123456789-0" → "7890"). */
export function ghanaCardLast4(card: string): string {
  return card.replace(/[^0-9]/g, '').slice(-4);
}

/** Field-level before/after for audit events: every defined key of `body` whose value differs from `before`. */
export function diffChanges(before: object, body: object): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const b = before as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) if (v !== undefined && JSON.stringify(b[k]) !== JSON.stringify(v)) out[k] = { before: b[k], after: v };
  return out;
}
