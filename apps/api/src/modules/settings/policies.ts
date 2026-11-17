// Owner: Agent B. Policy switches stored in app.settings (key → jsonb value). Every key has its own Zod schema.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const POLICY_SCHEMAS = {
  'promotion.block_on_arrears': z.enum(['off', 'warn', 'block']),
  'promotion.undo_window_days': z.number().int().min(1).max(90),
  'attendance.sms_on_absence': z.boolean(),
  'attendance.pm_session_enabled': z.boolean(),
  'finance.allocation_order': z.enum(['oldest_first', 'priority']),
  'finance.overpayment_as_credit': z.boolean(),
  'messages.bulk_approval_threshold': z.number().int().min(1).max(10000),
  'students.duplicate_similarity_threshold': z.number().min(0.3).max(1),
  'retention.alumni_years': z.number().int().min(1).max(100),
  'retention.audit_years': z.number().int().min(1).max(100),
  'retention.finance_years': z.number().int().min(6).max(100),
  'academics.position_display': z.enum(['show', 'hide']),
} as const;

export type PolicyKey = keyof typeof POLICY_SCHEMAS;
export type Policies = { [K in PolicyKey]: z.infer<(typeof POLICY_SCHEMAS)[K]> };

export const POLICY_DEFAULTS: Policies = {
  'promotion.block_on_arrears': 'warn',
  'promotion.undo_window_days': 14,
  'attendance.sms_on_absence': false,
  'attendance.pm_session_enabled': false,
  'finance.allocation_order': 'oldest_first',
  'finance.overpayment_as_credit': true,
  'messages.bulk_approval_threshold': 50,
  'students.duplicate_similarity_threshold': 0.6,
  'retention.alumni_years': 25,
  'retention.audit_years': 7,
  'retention.finance_years': 7,
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
