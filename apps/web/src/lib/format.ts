import { formatCedis, parseCedis, SCHOOL_TIMEZONE, todayInAccra } from '@sms/shared';

export { formatCedis, parseCedis, todayInAccra };

/** Money for display. Always integer pesewas in, never floats. */
export function money(pesewas: number | null | undefined): string {
  if (pesewas === null || pesewas === undefined) return '—';
  return formatCedis(pesewas);
}

/** Parse what the user typed; returns null when it is not a valid amount. */
export function tryParseCedis(input: string): number | null {
  if (!input.trim()) return null;
  try {
    return parseCedis(input);
  } catch {
    return null;
  }
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SCHOOL_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SCHOOL_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SCHOOL_TIMEZONE, hour: '2-digit', minute: '2-digit' });

/** "12 Nov 2026". Accepts YYYY-MM-DD (calendar date) or an ISO instant (shown in Africa/Accra). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return Number.isNaN(d.getTime()) ? value : dateFmt.format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : dateTimeFmt.format(d);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : timeFmt.format(d);
}

/** Convert a local date (YYYY-MM-DD, Accra = UTC+0 all year) to an ISO instant at the current time of day. */
export function dateToInstant(date: string): string {
  const now = new Date();
  if (date === todayInAccra(now)) return now.toISOString();
  return new Date(`${date}T12:00:00Z`).toISOString();
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer / deposit',
  cheque: 'Cheque',
  momo_mtn: 'MTN Mobile Money',
  telecel_cash: 'Telecel Cash',
  at_money: 'AT Money',
};

export const STATUS_LABELS: Record<string, string> = {
  applicant: 'Applicant',
  active: 'Active',
  withdrawn: 'Withdrawn',
  transferred_out: 'Transferred out',
  alumni: 'Alumni',
  deceased: 'Deceased',
};

/** Display a +233 number the way Ghanaians write it: 024 000 0123. */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const m = /^\+233(\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
