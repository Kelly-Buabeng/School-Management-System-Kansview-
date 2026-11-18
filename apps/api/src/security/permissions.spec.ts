import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, permissionsForRoles, type Permission, type Role } from './permissions';

/**
 * Role × permission matrix transcribed row by row from docs/contracts/rbac.md ("Matrix" table).
 * Legend mapping: R → :read, C → :create, U → :update, A → :archive, X → :export, Ap → :approve / *_approve,
 * "own"/"mask"/"alert" cells are scope or field rules (ScopeService/FieldPolicy) and grant the base permission only.
 * Every cell of every role is asserted below (generated test cases), so any drift between permissions.ts and
 * rbac.md fails CI.
 */
type Row = [resource: string, perms: Record<Role, Permission[]>];
const none: Permission[] = [];
const MATRIX: Row[] = [
  ['Students core profile', {
    ADMIN: ['students:read', 'students:create', 'students:update', 'students:archive', 'students:export'],
    BURSAR: ['students:read'], HEADTEACHER: ['students:read', 'students:export'],
    REGISTRAR: ['students:read', 'students:create', 'students:update', 'students:export'], TEACHER: ['students:read'] }],
  ['Student documents', {
    ADMIN: ['student_documents:read', 'student_documents:create', 'student_documents:archive'], BURSAR: none,
    HEADTEACHER: ['student_documents:read'], REGISTRAR: ['student_documents:read', 'student_documents:create'], TEACHER: none }],
  ['Medical record full detail', {
    ADMIN: ['medical:read', 'medical:update'], BURSAR: none, HEADTEACHER: ['medical:read'],
    REGISTRAR: ['medical:read', 'medical:update'], TEACHER: none }],
  ['Emergency View', { ADMIN: ['emergency_view:read'], BURSAR: ['emergency_view:read'], HEADTEACHER: ['emergency_view:read'], REGISTRAR: ['emergency_view:read'], TEACHER: ['emergency_view:read'] }],
  ['Emergency contact log', {
    ADMIN: ['emergency_log:create', 'emergency_log:read'], BURSAR: ['emergency_log:create'], HEADTEACHER: ['emergency_log:create', 'emergency_log:read'],
    REGISTRAR: ['emergency_log:create', 'emergency_log:read'], TEACHER: ['emergency_log:create'] }],
  ['Guardians', {
    ADMIN: ['guardians:read', 'guardians:create', 'guardians:update'], BURSAR: ['guardians:read'], HEADTEACHER: ['guardians:read'],
    REGISTRAR: ['guardians:read', 'guardians:create', 'guardians:update'], TEACHER: ['guardians:read'] }],
  ['Ghana Card reveal', { ADMIN: ['ghana_card:reveal'], BURSAR: none, HEADTEACHER: none, REGISTRAR: none, TEACHER: none }],
  ['Authorised pickups', {
    ADMIN: ['pickups:read', 'pickups:create', 'pickups:update', 'pickups:archive'], BURSAR: none, HEADTEACHER: ['pickups:read'],
    REGISTRAR: ['pickups:read', 'pickups:create', 'pickups:update', 'pickups:archive'], TEACHER: ['pickups:read'] }],
  ['Academic setup', {
    ADMIN: ['academic_setup:read', 'academic_setup:create', 'academic_setup:update'], BURSAR: ['academic_setup:read'],
    HEADTEACHER: ['academic_setup:read'], REGISTRAR: ['academic_setup:read'], TEACHER: ['academic_setup:read'] }],
  ['Enrolment', {
    ADMIN: ['enrolments:read', 'enrolments:update'], BURSAR: ['enrolments:read'], HEADTEACHER: ['enrolments:read'],
    REGISTRAR: ['enrolments:read', 'enrolments:update'], TEACHER: ['enrolments:read'] }],
  ['Promotion runs', {
    ADMIN: ['promotion:read', 'promotion:create', 'promotion:update', 'promotion:commit', 'promotion:undo'], BURSAR: ['promotion:read'],
    HEADTEACHER: ['promotion:read'], REGISTRAR: none, TEACHER: none }],
  ['Withdrawals', {
    ADMIN: ['withdrawals:read', 'withdrawals:create', 'withdrawals:update', 'withdrawals:complete', 'withdrawals:export'],
    BURSAR: ['withdrawals:read', 'withdrawals:update'], HEADTEACHER: ['withdrawals:read'],
    REGISTRAR: ['withdrawals:read', 'withdrawals:create', 'withdrawals:update', 'withdrawals:export'], TEACHER: none }],
  ['Staff records', {
    ADMIN: ['staff:read', 'staff:create', 'staff:update', 'staff:archive'], BURSAR: ['staff:read'], HEADTEACHER: ['staff:read'],
    REGISTRAR: ['staff:read'], TEACHER: none }],
  ['Staff sensitive', { ADMIN: ['staff_sensitive:reveal'], BURSAR: none, HEADTEACHER: none, REGISTRAR: none, TEACHER: none }],
  ['Attendance', {
    ADMIN: ['attendance:read', 'attendance:update'], BURSAR: none, HEADTEACHER: ['attendance:read'],
    REGISTRAR: ['attendance:read', 'attendance:update'], TEACHER: ['attendance:read', 'attendance:update'] }],
  ['Scores and report cards', {
    ADMIN: ['academics:read', 'academics:update', 'academics:export', 'academics:publish'], BURSAR: none,
    HEADTEACHER: ['academics:read', 'academics:update', 'academics:publish', 'academics:export'], REGISTRAR: none,
    TEACHER: ['academics:read', 'academics:update'] }],
  ['Incidents', {
    ADMIN: ['incidents:read', 'incidents:create', 'incidents:update'], BURSAR: none, HEADTEACHER: ['incidents:read', 'incidents:create', 'incidents:update'],
    REGISTRAR: ['incidents:create'], TEACHER: ['incidents:create', 'incidents:read'] }],
  ['Health visits', {
    ADMIN: ['health_visits:read', 'health_visits:create', 'health_visits:update'], BURSAR: none, HEADTEACHER: ['health_visits:read'],
    REGISTRAR: ['health_visits:read', 'health_visits:create', 'health_visits:update'], TEACHER: ['health_visits:create'] }],
  ['Fee structures', {
    ADMIN: ['fee_structures:read', 'fee_structures:activate'], BURSAR: ['fee_structures:read', 'fee_structures:create', 'fee_structures:update'],
    HEADTEACHER: ['fee_structures:read'], REGISTRAR: none, TEACHER: none }],
  ['Invoices', {
    ADMIN: ['invoices:read', 'invoices:export'], BURSAR: ['invoices:read', 'invoices:create', 'invoices:export', 'invoices:void'],
    HEADTEACHER: ['invoices:read', 'invoices:export'], REGISTRAR: none, TEACHER: none }],
  // ADMIN reads payments for statements/reports and approves late reversals, but never records them (separation of duties).
  ['Payments and reversals', {
    ADMIN: ['payments:read', 'payments:reverse_approve'], BURSAR: ['payments:create', 'payments:read', 'payments:reverse'],
    HEADTEACHER: ['payments:read'], REGISTRAR: none, TEACHER: none }],
  ['Adjustments', {
    ADMIN: ['adjustments:create', 'adjustments:approve', 'adjustments:read'], BURSAR: ['adjustments:create', 'adjustments:read'],
    HEADTEACHER: ['adjustments:approve', 'adjustments:read'], REGISTRAR: none, TEACHER: none }],
  ['Balances and statements', {
    ADMIN: ['balances:read', 'balances:export'], BURSAR: ['balances:read', 'balances:export'], HEADTEACHER: ['balances:read', 'balances:export'],
    REGISTRAR: ['balances:read'], TEACHER: none }],
  ['Finance reports', { ADMIN: ['finance_reports:read'], BURSAR: ['finance_reports:read'], HEADTEACHER: ['finance_reports:read'], REGISTRAR: none, TEACHER: none }],
  ['Cash-up', { ADMIN: ['cash_up:read'], BURSAR: ['cash_up:read', 'cash_up:create', 'cash_up:close'], HEADTEACHER: ['cash_up:read'], REGISTRAR: none, TEACHER: none }],
  ['Messages', {
    ADMIN: ['messages:send', 'messages:bulk', 'messages:bulk_approve', 'messages:emergency', 'messages:read'],
    BURSAR: ['messages:send', 'messages:bulk', 'messages:read'], HEADTEACHER: ['messages:send', 'messages:bulk', 'messages:emergency', 'messages:read'],
    REGISTRAR: ['messages:send', 'messages:bulk', 'messages:read'], TEACHER: none }],
  ['Message templates', {
    ADMIN: ['templates:read', 'templates:create', 'templates:update'], BURSAR: ['templates:read'], HEADTEACHER: ['templates:read'],
    REGISTRAR: ['templates:read'], TEACHER: none }],
  ['Bulk import', {
    ADMIN: ['imports:read', 'imports:create', 'imports:commit'], BURSAR: ['imports:read', 'imports:create'], HEADTEACHER: none,
    REGISTRAR: ['imports:read', 'imports:create'], TEACHER: none }],
  ['Dashboards', { ADMIN: ['dashboard:read'], BURSAR: ['dashboard:read'], HEADTEACHER: ['dashboard:read'], REGISTRAR: ['dashboard:read'], TEACHER: ['dashboard:read'] }],
  ['Search', { ADMIN: ['search:read'], BURSAR: ['search:read'], HEADTEACHER: ['search:read'], REGISTRAR: ['search:read'], TEACHER: ['search:read'] }],
  ['Users and roles', { ADMIN: ['users:read', 'users:create', 'users:update'], BURSAR: none, HEADTEACHER: none, REGISTRAR: none, TEACHER: none }],
  ['Settings', { ADMIN: ['settings:read', 'settings:update'], BURSAR: ['settings:read'], HEADTEACHER: ['settings:read'], REGISTRAR: ['settings:read'], TEACHER: none }],
  ['Audit log', { ADMIN: ['audit:read', 'audit:export'], BURSAR: none, HEADTEACHER: ['audit:read'], REGISTRAR: none, TEACHER: none }],
  ['Data protection', {
    ADMIN: ['dpa:read', 'dpa:create', 'dpa:update', 'dpa:export', 'dpa:anonymise'], BURSAR: none, HEADTEACHER: ['dpa:read'],
    REGISTRAR: ['dpa:create'], TEACHER: none }],
  ['System', { ADMIN: ['system:read'], BURSAR: none, HEADTEACHER: none, REGISTRAR: none, TEACHER: none }],
];

const expected: Record<Role, Set<Permission>> = Object.fromEntries(ROLES.map((r) => [r, new Set(MATRIX.flatMap(([, m]) => m[r]))])) as Record<Role, Set<Permission>>;

describe('RBAC matrix (rbac.md) ↔ ROLE_PERMISSIONS', () => {
  const cases = ROLES.flatMap((role) => PERMISSIONS.map((perm) => [role, perm, expected[role].has(perm)] as const));

  it.each(cases)('%s / %s → granted=%s', (role, perm, granted) => {
    expect(ROLE_PERMISSIONS[role].includes(perm)).toBe(granted);
  });

  it('every permission in the catalogue is covered by a matrix row and granted to someone', () => {
    const inMatrix = new Set(MATRIX.flatMap(([, m]) => ROLES.flatMap((r) => m[r])));
    expect(PERMISSIONS.filter((p) => !inMatrix.has(p))).toEqual([]);
  });

  it('role lists contain no duplicates', () => {
    for (const r of ROLES) expect(new Set(ROLE_PERMISSIONS[r]).size).toBe(ROLE_PERMISSIONS[r].length);
  });

  it('invariants: separation of duties and secrets', () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('payments:create');
    expect(ROLE_PERMISSIONS.BURSAR).not.toContain('payments:reverse_approve');
    expect(ROLE_PERMISSIONS.BURSAR).not.toContain('adjustments:approve');
    for (const r of ROLES.filter((x) => x !== 'ADMIN')) {
      for (const p of ['users:create', 'users:update', 'ghana_card:reveal', 'staff_sensitive:reveal', 'dpa:anonymise', 'system:read', 'audit:export'] as const) {
        expect(ROLE_PERMISSIONS[r]).not.toContain(p);
      }
    }
    expect(ROLE_PERMISSIONS.TEACHER).not.toContain('medical:read');
    expect(ROLE_PERMISSIONS.BURSAR).not.toContain('medical:read');
  });

  it('multiple roles are a union', () => {
    const both = permissionsForRoles(['ADMIN', 'BURSAR']);
    expect(both.has('payments:create')).toBe(true);
    expect(both.has('users:create')).toBe(true);
    expect(permissionsForRoles([]).size).toBe(0);
  });
});
