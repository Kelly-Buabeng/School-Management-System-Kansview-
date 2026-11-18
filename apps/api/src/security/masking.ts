/**
 * Masks sensitive values before they reach the audit log or application logs.
 * Rule of thumb: the audit log records THAT a sensitive field changed, never its value.
 */
const SECRET_KEY = /(password|passphrase|secret|token|otp|totp|recovery|mfa_?secret|_enc$|enc$|bidx|hash$)/i;
const SENSITIVE_KEY = /(ghana_?card|ssnit|allerg|chronic|medication|special_?needs|medical|diagnos|condition|treatment|complaint|blood_?group|health)/i;
const PHONE_KEY = /(phone|whatsapp|mobile|msisdn)/i;

export const REDACTED = '[REDACTED]';

export function maskPhone(v: string): string {
  const digits = v.replace(/[^\d+]/g, '');
  if (digits.length < 7) return '•••';
  return `${digits.slice(0, 4)}•••••${digits.slice(-3)}`;
}

/** Masks a single value based on its field name. */
export function maskValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY.test(key) || SENSITIVE_KEY.test(key)) return REDACTED;
  if (PHONE_KEY.test(key) && typeof value === 'string') return maskPhone(value);
  if (Buffer.isBuffer(value)) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v !== null ? maskObject(v as Record<string, unknown>) : v));
  if (typeof value === 'object') return maskObject(value as Record<string, unknown>);
  return value;
}

export function maskObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = maskValue(k, v);
  return out;
}

/** For AuditEvent.changes: `{ field: { before, after } }`. */
export function maskChanges(changes: Record<string, { before?: unknown; after?: unknown }> | null | undefined):
  Record<string, { before?: unknown; after?: unknown }> | null {
  if (!changes) return null;
  const out: Record<string, { before?: unknown; after?: unknown }> = {};
  for (const [field, c] of Object.entries(changes)) {
    const entry: { before?: unknown; after?: unknown } = {};
    if ('before' in c) entry.before = maskValue(field, c.before);
    if ('after' in c) entry.after = maskValue(field, c.after);
    out[field] = entry;
  }
  return out;
}
