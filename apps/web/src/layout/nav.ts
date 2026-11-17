/** Navigation items. An item shows if the user has ANY of its permissions. The server still checks every request. */
export interface NavItem {
  label: string;
  to: string;
  perms: string[];
  group: 'Main' | 'Students' | 'Teaching' | 'Finance' | 'Communication' | 'Administration';
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', perms: ['dashboard:read'], group: 'Main' },
  { label: 'Students', to: '/students', perms: ['students:read'], group: 'Students' },
  { label: 'Admit a student', to: '/students/new', perms: ['students:create'], group: 'Students' },
  { label: 'Classes', to: '/classes', perms: ['academic_setup:read'], group: 'Students' },
  { label: 'Promotion', to: '/promotion', perms: ['promotion:read'], group: 'Students' },
  { label: 'Withdrawals', to: '/withdrawals', perms: ['withdrawals:read'], group: 'Students' },
  { label: 'Attendance', to: '/attendance', perms: ['attendance:update'], group: 'Teaching' },
  { label: 'Score entry', to: '/scores', perms: ['academics:update'], group: 'Teaching' },
  { label: 'Report cards', to: '/report-cards', perms: ['academics:read'], group: 'Teaching' },
  { label: 'Record payment', to: '/finance/payments/new', perms: ['payments:create'], group: 'Finance' },
  { label: 'Payments', to: '/finance/payments', perms: ['payments:read'], group: 'Finance' },
  { label: 'Fee structures', to: '/finance/fees', perms: ['fee_structures:read'], group: 'Finance' },
  { label: 'Invoices', to: '/finance/invoices', perms: ['invoices:create', 'invoices:read'], group: 'Finance' },
  { label: 'Adjustments', to: '/finance/adjustments', perms: ['adjustments:read'], group: 'Finance' },
  { label: 'Cash-up', to: '/finance/cash-up', perms: ['cash_up:read'], group: 'Finance' },
  { label: 'Finance reports', to: '/finance/reports', perms: ['finance_reports:read'], group: 'Finance' },
  { label: 'Messages', to: '/messages', perms: ['messages:read'], group: 'Communication' },
  { label: 'Imports', to: '/imports', perms: ['imports:read'], group: 'Administration' },
  { label: 'Staff', to: '/staff', perms: ['staff:read'], group: 'Administration' },
  { label: 'Settings', to: '/settings', perms: ['settings:update'], group: 'Administration' },
  { label: 'Users', to: '/users', perms: ['users:read'], group: 'Administration' },
  { label: 'Audit log', to: '/audit', perms: ['audit:read'], group: 'Administration' },
];

export function visibleNav(permissions: Iterable<string>): NavItem[] {
  const set = new Set(permissions);
  return NAV_ITEMS.filter((i) => i.perms.some((p) => set.has(p)));
}
