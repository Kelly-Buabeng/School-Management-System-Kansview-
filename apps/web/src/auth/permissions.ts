/**
 * Role → permission map, copied (data only) from apps/api/src/security/permissions.ts so the mock server and
 * the UI agree with the real server. The server is always the real control; the UI only hides what a user cannot use.
 * If the server's map changes, update this copy (the real API returns effective permissions in GET /auth/me,
 * so in real mode the UI uses those, not this table).
 */
export type Role = 'ADMIN' | 'BURSAR' | 'HEADTEACHER' | 'REGISTRAR' | 'TEACHER';

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrator',
  BURSAR: 'Bursar',
  HEADTEACHER: 'Headteacher',
  REGISTRAR: 'Registrar',
  TEACHER: 'Teacher',
};

const p = (...perms: string[]) => perms;

export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  ADMIN: p(
    'academic_setup:create', 'academic_setup:read', 'academic_setup:update',
    'academics:export', 'academics:publish', 'academics:read', 'academics:update',
    'adjustments:approve', 'adjustments:create', 'adjustments:read',
    'attendance:read', 'attendance:update',
    'audit:read', 'audit:export',
    'balances:export', 'balances:read', 'cash_up:read', 'dashboard:read',
    'dpa:anonymise', 'dpa:create', 'dpa:export', 'dpa:read', 'dpa:update',
    'emergency_log:create', 'emergency_log:read', 'emergency_view:read',
    'enrolments:read', 'enrolments:update',
    'fee_structures:activate', 'fee_structures:read',
    'finance_reports:read', 'ghana_card:reveal',
    'guardians:create', 'guardians:read', 'guardians:update',
    'health_visits:create', 'health_visits:read', 'health_visits:update',
    'imports:commit', 'imports:create', 'imports:read',
    'incidents:create', 'incidents:read', 'incidents:update',
    'invoices:export', 'invoices:read',
    'medical:read', 'medical:update',
    'messages:bulk', 'messages:bulk_approve', 'messages:emergency', 'messages:read', 'messages:send',
    'payments:read', 'payments:reverse_approve',
    'pickups:archive', 'pickups:create', 'pickups:read', 'pickups:update',
    'promotion:commit', 'promotion:create', 'promotion:read', 'promotion:undo', 'promotion:update',
    'search:read', 'settings:read', 'settings:update',
    'staff:archive', 'staff:create', 'staff:read', 'staff:update', 'staff_sensitive:reveal',
    'student_documents:archive', 'student_documents:create', 'student_documents:read',
    'students:archive', 'students:create', 'students:export', 'students:read', 'students:update',
    'system:read', 'templates:create', 'templates:read', 'templates:update',
    'users:create', 'users:read', 'users:update',
    'withdrawals:complete', 'withdrawals:create', 'withdrawals:export', 'withdrawals:read', 'withdrawals:update',
  ),
  BURSAR: p(
    'academic_setup:read', 'adjustments:create', 'adjustments:read',
    'balances:export', 'balances:read', 'cash_up:close', 'cash_up:create', 'cash_up:read',
    'dashboard:read', 'emergency_log:create', 'emergency_view:read', 'enrolments:read',
    'fee_structures:create', 'fee_structures:read', 'fee_structures:update',
    'finance_reports:read', 'guardians:read', 'imports:create', 'imports:read',
    'invoices:create', 'invoices:export', 'invoices:read', 'invoices:void',
    'messages:bulk', 'messages:read', 'messages:send',
    'payments:create', 'payments:read', 'payments:reverse',
    'promotion:read', 'search:read', 'settings:read', 'staff:read', 'students:read',
    'templates:read', 'withdrawals:read', 'withdrawals:update',
  ),
  HEADTEACHER: p(
    'academic_setup:read', 'academics:export', 'academics:publish', 'academics:read', 'academics:update',
    'adjustments:approve', 'adjustments:read', 'attendance:read', 'audit:read',
    'balances:export', 'balances:read', 'cash_up:read', 'dashboard:read', 'dpa:read',
    'emergency_log:create', 'emergency_log:read', 'emergency_view:read', 'enrolments:read',
    'fee_structures:read', 'finance_reports:read', 'guardians:read',
    'health_visits:read', 'incidents:create', 'incidents:read', 'incidents:update',
    'invoices:export', 'invoices:read', 'medical:read',
    'messages:bulk', 'messages:emergency', 'messages:read', 'messages:send',
    'payments:read', 'pickups:read', 'promotion:read', 'search:read', 'settings:read',
    'staff:read', 'student_documents:read', 'students:export', 'students:read',
    'templates:read', 'withdrawals:read',
  ),
  REGISTRAR: p(
    'academic_setup:read', 'attendance:read', 'attendance:update', 'balances:read', 'dashboard:read', 'dpa:create',
    'emergency_log:create', 'emergency_log:read', 'emergency_view:read',
    'enrolments:read', 'enrolments:update',
    'guardians:create', 'guardians:read', 'guardians:update',
    'health_visits:create', 'health_visits:read', 'health_visits:update',
    'imports:create', 'imports:read', 'incidents:create',
    'medical:read', 'medical:update', 'messages:bulk', 'messages:read', 'messages:send',
    'pickups:archive', 'pickups:create', 'pickups:read', 'pickups:update',
    'search:read', 'settings:read', 'staff:read',
    'student_documents:create', 'student_documents:read',
    'students:create', 'students:export', 'students:read', 'students:update',
    'templates:read', 'withdrawals:create', 'withdrawals:export', 'withdrawals:read', 'withdrawals:update',
  ),
  TEACHER: p(
    'academic_setup:read', 'academics:read', 'academics:update', 'attendance:read', 'attendance:update',
    'dashboard:read', 'emergency_log:create', 'emergency_view:read', 'enrolments:read',
    'guardians:read', 'health_visits:create', 'incidents:create', 'incidents:read',
    'pickups:read', 'search:read', 'students:read',
  ),
};

export function permissionsForRoles(roles: readonly Role[]): string[] {
  const out = new Set<string>();
  for (const r of roles) for (const perm of ROLE_PERMISSIONS[r] ?? []) out.add(perm);
  return [...out].sort();
}
