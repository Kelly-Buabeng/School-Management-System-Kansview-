import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { RouteObject } from 'react-router';
import { AppLayout, NotFoundPage, PageLoader, RequireAuth } from '@/layout/AppLayout';

// Every screen is its own chunk so the first load stays small on slow connections.
type Lazy = LazyExoticComponent<ComponentType>;
const page = (factory: () => Promise<{ default: ComponentType }>): Lazy => lazy(factory);
const el = (C: Lazy) => (
  <Suspense fallback={<PageLoader />}>
    <C />
  </Suspense>
);

const LoginPage = page(() => import('@/auth/LoginPages').then((m) => ({ default: m.LoginPage })));
const MfaPage = page(() => import('@/auth/LoginPages').then((m) => ({ default: m.MfaPage })));
const ChangePasswordPage = page(() => import('@/auth/LoginPages').then((m) => ({ default: m.ChangePasswordPage })));

export const pages = {
  dashboard: page(() => import('@/features/dashboard/DashboardPage')),
  students: page(() => import('@/features/students/StudentListPage')),
  studentProfile: page(() => import('@/features/students/StudentProfilePage')),
  admission: page(() => import('@/features/students/AdmissionWizard')),
  guardian: page(() => import('@/features/guardians/GuardianPage')),
  emergency: page(() => import('@/features/emergency/EmergencyViewPage')),
  recordPayment: page(() => import('@/features/finance/RecordPaymentPage')),
  payments: page(() => import('@/features/finance/PaymentsPage')),
  receipt: page(() => import('@/features/finance/ReceiptPage')),
  fees: page(() => import('@/features/finance/FeesPage')),
  invoices: page(() => import('@/features/finance/InvoicesPage')),
  adjustments: page(() => import('@/features/finance/AdjustmentsPage')),
  cashUp: page(() => import('@/features/finance/CashUpPage')),
  financeReports: page(() => import('@/features/finance/ReportsPage')),
  classes: page(() => import('@/features/classes/ClassesPages').then((m) => ({ default: m.ClassListPage }))),
  classRoll: page(() => import('@/features/classes/ClassesPages').then((m) => ({ default: m.ClassRollPage }))),
  promotion: page(() => import('@/features/classes/PromotionWizard')),
  withdrawals: page(() => import('@/features/classes/WithdrawalsPage')),
  attendance: page(() => import('@/features/academics/AttendancePage')),
  scores: page(() => import('@/features/academics/ScoresPage')),
  reportCards: page(() => import('@/features/academics/ReportCardsPage')),
  messages: page(() => import('@/features/messages/MessagesPage')),
  imports: page(() => import('@/features/imports/ImportsPage')),
  staff: page(() => import('@/features/admin/AdminPages').then((m) => ({ default: m.StaffPage }))),
  settings: page(() => import('@/features/admin/AdminPages').then((m) => ({ default: m.SettingsPage }))),
  users: page(() => import('@/features/admin/AdminPages').then((m) => ({ default: m.UsersPage }))),
  audit: page(() => import('@/features/admin/AdminPages').then((m) => ({ default: m.AuditPage }))),
};

export const routes: RouteObject[] = [
  { path: '/login', element: el(LoginPage) },
  { path: '/mfa', element: el(MfaPage) },
  { path: '/change-password', element: <RequireAuth>{el(ChangePasswordPage)}</RequireAuth> },
  // Emergency View is full-screen (phone first), outside the menu layout.
  { path: '/students/:id/emergency', element: <RequireAuth>{el(pages.emergency)}</RequireAuth> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: el(pages.dashboard) },
      { path: 'students', element: el(pages.students) },
      { path: 'students/new', element: el(pages.admission) },
      { path: 'students/:id', element: el(pages.studentProfile) },
      { path: 'guardians/:id', element: el(pages.guardian) },
      { path: 'classes', element: el(pages.classes) },
      { path: 'classes/:id', element: el(pages.classRoll) },
      { path: 'promotion', element: el(pages.promotion) },
      { path: 'withdrawals', element: el(pages.withdrawals) },
      { path: 'attendance', element: el(pages.attendance) },
      { path: 'scores', element: el(pages.scores) },
      { path: 'report-cards', element: el(pages.reportCards) },
      { path: 'finance/payments/new', element: el(pages.recordPayment) },
      { path: 'finance/payments', element: el(pages.payments) },
      { path: 'finance/payments/:id', element: el(pages.receipt) },
      { path: 'finance/fees', element: el(pages.fees) },
      { path: 'finance/invoices', element: el(pages.invoices) },
      { path: 'finance/adjustments', element: el(pages.adjustments) },
      { path: 'finance/cash-up', element: el(pages.cashUp) },
      { path: 'finance/reports', element: el(pages.financeReports) },
      { path: 'messages', element: el(pages.messages) },
      { path: 'imports', element: el(pages.imports) },
      { path: 'staff', element: el(pages.staff) },
      { path: 'settings', element: el(pages.settings) },
      { path: 'users', element: el(pages.users) },
      { path: 'audit', element: el(pages.audit) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
