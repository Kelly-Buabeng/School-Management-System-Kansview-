// Owner: Agent B. Policy switches stored in app.settings (key → jsonb value). Every key has its own Zod schema.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const POLICY_SCHEMAS = {
  'promotion.block_on_arrears': z.enum(['off', 'warn', 'block']),
  'promotion.undo_window_days': z.number().int().min(1).max(90),
  'attendance.sms_on_absence': z.boolean(),
  'attendance.pm_session_enabled': z.boolean(),
  'finance.allocation_order': z.enum(['oldest_first_by_priority', 'oldest_first', 'priority']),
  'finance.reversal_after_cashup_requires_admin': z.boolean(),
  'finance.duplicate_reference_warning': z.boolean(),
  'messaging.bulk_approval_threshold': z.number().int().min(1).max(10000),
  'messaging.default_channel': z.enum(['sms', 'whatsapp']),
  'security.session_idle_minutes': z.number().int().min(5).max(240),
  'security.session_absolute_hours': z.number().int().min(1).max(24),
  'security.lockout_threshold': z.number().int().min(3).max(20),
  'security.lockout_minutes': z.number().int().min(1).max(1440),
  'dpa.request_response_days': z.number().int().min(1).max(90),
  'retention.student_records_years_after_leaving': z.number().int().min(1).max(100),
  'retention.finance_records_years': z.number().int().min(6).max(100),
  'retention.audit_events_years': z.number().int().min(1).max(100),
  'retention.login_attempts_days': z.number().int().min(1).max(3650),
  'retention.idempotency_records_days': z.number().int().min(1).max(365),
  'retention.message_bodies_days': z.number().int().min(1).max(3650),
  'students.duplicate_similarity_threshold': z.number().min(0.3).max(1),
  'academics.position_display': z.enum(['show', 'hide']),
} as const;

export type PolicyKey = keyof typeof POLICY_SCHEMAS;
export type Policies = { [K in PolicyKey]: z.infer<(typeof POLICY_SCHEMAS)[K]> };

export const POLICY_DEFAULTS: Policies = {
  'promotion.block_on_arrears': 'warn',
  'promotion.undo_window_days': 14,
  'attendance.sms_on_absence': true,
  'attendance.pm_session_enabled': false,
  'finance.allocation_order': 'oldest_first_by_priority',
  'finance.reversal_after_cashup_requires_admin': true,
  'finance.duplicate_reference_warning': true,
  'messaging.bulk_approval_threshold': 50,
  'messaging.default_channel': 'sms',
  'security.session_idle_minutes': 30,
  'security.session_absolute_hours': 12,
  'security.lockout_threshold': 5,
  'security.lockout_minutes': 15,
  'dpa.request_response_days': 21,
  'retention.student_records_years_after_leaving': 7,
  'retention.finance_records_years': 7,
  'retention.audit_events_years': 7,
  'retention.login_attempts_days': 90,
  'retention.idempotency_records_days': 7,
  'retention.message_bodies_days': 365,
  'students.duplicate_similarity_threshold': 0.6,
  'academics.position_display': 'show',
};

export const POLICY_KEYS = Object.keys(POLICY_SCHEMAS) as PolicyKey[];

/** Strict partial update: unknown keys are rejected, each value validated by its key's schema. */
export const UpdatePoliciesBody = z.strictObject(
  Object.fromEntries(POLICY_KEYS.map((k) => [k, POLICY_SCHEMAS[k].optional()])) as { [K in PolicyKey]: z.ZodOptional<(typeof POLICY_SCHEMAS)[K]> },
);
export type UpdatePoliciesBody = z.infer<typeof UpdatePoliciesBody>;

/** Merges stored rows over defaults. Stored values that no longer validate fall back to the default (and are reported). */
export function mergePolicies(rows: Array<{ key: string; value: unknown }>): { policies: Policies; invalidKeys: string[] } {
  const policies: Record<string, unknown> = { ...POLICY_DEFAULTS };
  const invalidKeys: string[] = [];
  for (const row of rows) {
    if (!(row.key in POLICY_SCHEMAS)) continue;
    const parsed = POLICY_SCHEMAS[row.key as PolicyKey].safeParse(row.value);
    if (parsed.success) policies[row.key] = parsed.data;
    else invalidKeys.push(row.key);
  }
  return { policies: policies as Policies, invalidKeys };
}

/** Opaque version tag for If-Match on PATCH /settings/policies. */
export function policiesEtag(p: Policies): string {
  const canonical = JSON.stringify(POLICY_KEYS.map((k) => [k, p[k]]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
