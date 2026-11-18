/** Navigation items. An item shows if the user has ANY of its permissions. The server still checks every request. */
export interface NavItem {
  label: string;
  to: string;
  perms: string[];
  /** 'Main' items follow the design's sidebar order; the rest are grouped below it. */
  group: 'Main' | 'Students and teaching' | 'Finance' | 'Office';
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', perms: ['dashboard:read'], group: 'Main' },
  { label: 'Students', to: '/students', perms: ['students:read'], group: 'Main' },
  { label: 'Guardians', to: '/guardians', perms: ['guardians:read'], group: 'Main' },
  { label: 'Record payment', to: '/finance/payments/new', perms: ['payments:create'], group: 'Main' },
  { label: 'Fee setup', to: '/finance/fees', perms: ['fee_structures:read'], group: 'Main' },
  { label: 'Receipts', to: '/finance/payments', perms: ['payments:read'], group: 'Main' },
  { label: 'Classes and promotion', to: '/classes', perms: ['academic_setup:read'], group: 'Main' },
  { label: 'Emergency', to: '/emergency', perms: ['emergency_view:read'], group: 'Main' },
  { label: 'Bulk message', to: '/messages', perms: ['messages:send', 'messages:read'], group: 'Main' },
  { label: 'Admit a student', to: '/students/new', perms: ['students:create'], group: 'Students and teaching' },
  { label: 'Year-end promotion', to: '/promotion', perms: ['promotion:read'], group: 'Students and teaching' },
  { label: 'Withdrawals', to: '/withdrawals', perms: ['withdrawals:read'], group: 'Students and teaching' },
  { label: 'Attendance', to: '/attendance', perms: ['attendance:update'], group: 'Students and teaching' },
  { label: 'Score entry', to: '/scores', perms: ['academics:update'], group: 'Students and teaching' },
  { label: 'Report cards', to: '/report-cards', perms: ['academics:read'], group: 'Students and teaching' },
  { label: 'Invoices', to: '/finance/invoices', perms: ['invoices:create', 'invoices:read'], group: 'Finance' },
  { label: 'Adjustments', to: '/finance/adjustments', perms: ['adjustments:read'], group: 'Finance' },
  { label: 'Cash-up', to: '/finance/cash-up', perms: ['cash_up:read'], group: 'Finance' },
  { label: 'Finance reports', to: '/finance/reports', perms: ['finance_reports:read'], group: 'Finance' },
  { label: 'Imports', to: '/imports', perms: ['imports:read'], group: 'Office' },
  { label: 'Staff', to: '/staff', perms: ['staff:read'], group: 'Office' },
  { label: 'Settings', to: '/settings', perms: ['settings:update'], group: 'Office' },
  { label: 'Users', to: '/users', perms: ['users:read'], group: 'Office' },
  { label: 'Audit log', to: '/audit', perms: ['audit:read'], group: 'Office' },
];

export function visibleNav(permissions: Iterable<string>): NavItem[] {
  const set = new Set(permissions);
  return NAV_ITEMS.filter((i) => i.perms.some((p) => set.has(p)));
}

/** Phone bottom tabs: Home · Students · Pay · Family · More (More is always shown). */
export function phoneTabs(permissions: Iterable<string>): { label: string; to: string }[] {
  const set = new Set(permissions);
  const tabs: { label: string; to: string }[] = [{ label: 'Home', to: '/' }];
  if (set.has('students:read')) tabs.push({ label: 'Students', to: '/students' });
  if (set.has('payments:create')) tabs.push({ label: 'Pay', to: '/finance/payments/new' });
  else if (set.has('payments:read')) tabs.push({ label: 'Pay', to: '/finance/payments' });
  if (set.has('guardians:read')) tabs.push({ label: 'Family', to: '/guardians' });
  return tabs;
}

/** Best title for the phone header from the current path. */
export function titleFor(pathname: string): string {
  if (/^\/students\/[^/]+\/emergency/.test(pathname)) return 'Emergency';
  if (/^\/students\/[^/]+$/.test(pathname) && pathname !== '/students/new') return 'Student';
  if (/^\/guardians\/[^/]+$/.test(pathname)) return 'Guardian';
  if (/^\/finance\/payments\/[^/]+$/.test(pathname) && pathname !== '/finance/payments/new') return 'Receipt';
  if (/^\/classes\/[^/]+$/.test(pathname)) return 'Class roll';
  let best: NavItem | undefined;
  for (const i of NAV_ITEMS) if ((i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`)) && (!best || i.to.length > best.to.length)) best = i;
  return best?.label ?? 'Kansview';
}
