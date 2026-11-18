// Owner: Agent F. No non-emergency SMS between 20:00 and 07:00 Africa/Accra.
import { SCHOOL_TIMEZONE } from '@sms/shared';

export const QUIET_START_HOUR = 20;
export const QUIET_END_HOUR = 7;

function accraParts(d: Date): { y: number; m: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHOOL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), day: get('day'), hour: get('hour') };
}

export function isQuietHours(now: Date): boolean {
  const { hour } = accraParts(now);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Earliest time a message may be sent. Emergencies go immediately. Otherwise, inside quiet hours the send is delayed
 * to the next 07:00 Accra time. Africa/Accra is UTC+0 with no daylight saving, so 07:00 Accra = 07:00Z.
 */
export function earliestSendTime(now: Date, emergency: boolean): Date {
  if (emergency || !isQuietHours(now)) return now;
  const { y, m, day, hour } = accraParts(now);
  const target = new Date(Date.UTC(y, m - 1, day, QUIET_END_HOUR, 0, 0));
  if (hour >= QUIET_START_HOUR) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}
