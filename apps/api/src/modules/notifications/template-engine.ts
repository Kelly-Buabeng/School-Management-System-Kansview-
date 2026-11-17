// Owner: Agent F. {{placeholder}} templates with a per-template-code allow-list. Plain text only.
import { AppError } from '../../common/app-error';
import type { TemplateCode } from '../../common/contracts';

/** Placeholders each template code may use. Values are always supplied by the system, never typed by parents. */
export const PLACEHOLDER_ALLOW_LIST: Record<TemplateCode | 'custom', readonly string[]> = {
  fee_reminder: ['guardianName', 'studentName', 'studentCode', 'className', 'balance', 'termName', 'dueDate', 'schoolName', 'schoolPhone'],
  absence_alert: ['guardianName', 'studentName', 'studentCode', 'className', 'date', 'schoolName', 'schoolPhone'],
  announcement: ['guardianName', 'studentName', 'className', 'message', 'date', 'schoolName', 'schoolPhone'],
  closure_notice: ['guardianName', 'studentName', 'date', 'reopenDate', 'message', 'schoolName', 'schoolPhone'],
  emergency: ['guardianName', 'studentName', 'message', 'schoolName', 'schoolPhone'],
  password_reset: ['fullName', 'code', 'minutes', 'schoolName'],
  custom: ['guardianName', 'studentName', 'studentCode', 'className', 'balance', 'schoolName', 'schoolPhone'],
};

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const HTML_TAG = /<\/?[A-Za-z][^>]*>|&[a-z]+;|&#\d+;/;

export const MAX_TEMPLATE_LENGTH = 640;

export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Throws TEMPLATE_PLACEHOLDER_INVALID listing the problems; used on template create/update and custom bodies. */
export function validateTemplate(code: TemplateCode | 'custom', body: string): string[] {
  const allowed = new Set(PLACEHOLDER_ALLOW_LIST[code] ?? []);
  const errors: Array<{ field: string; code: string; message: string }> = [];
  if (HTML_TAG.test(body)) errors.push({ field: 'body', code: 'HTML_NOT_ALLOWED', message: 'Messages are plain text. Please remove HTML tags.' });
  const stripped = body.replace(PLACEHOLDER, '');
  if (/\{\{|\}\}/.test(stripped)) {
    errors.push({ field: 'body', code: 'MALFORMED_PLACEHOLDER', message: 'A placeholder is not written correctly. Use {{name}}.' });
  }
  const used = placeholdersIn(body);
  for (const p of used) {
    if (!allowed.has(p)) {
      errors.push({ field: 'body', code: 'UNKNOWN_PLACEHOLDER', message: `{{${p}}} cannot be used here. Allowed: ${[...allowed].map((a) => `{{${a}}}`).join(', ')}` });
    }
  }
  if (body.length > MAX_TEMPLATE_LENGTH) errors.push({ field: 'body', code: 'TOO_LONG', message: `Keep messages under ${MAX_TEMPLATE_LENGTH} characters.` });
  if (errors.length) {
    throw new AppError(422, 'TEMPLATE_PLACEHOLDER_INVALID', 'The message template needs attention', errors.map((e) => e.message).join(' '), errors);
  }
  return used;
}

/** Replaces placeholders. Values are flattened to one line and stripped of braces/HTML so they cannot inject more placeholders. */
export function renderTemplate(body: string, context: Record<string, string | number | null | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(PLACEHOLDER, (_m, name: string) => {
    const v = context[name];
    if (v === null || v === undefined || v === '') {
      missing.push(name);
      return '';
    }
    return String(v).replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim();
  });
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim(), missing };
}
