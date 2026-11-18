import './shell.css';
import { Button, Center, Drawer, Group, Loader, Modal, Popover, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api, API_MODE } from '@/api/client';
import { listOf } from '@/api/normalise';
import { useAuth } from '@/auth/AuthContext';
import { ROLE_LABELS, type Role } from '@/auth/permissions';
import { GlobalSearch } from './GlobalSearch';
import { phoneTabs, titleFor, visibleNav, type NavItem } from './nav';
import { OfflineBanner } from './OfflineBanner';

const MockPanel = lazy(() => import('./MockPanel'));

export function PageLoader() {
  return (
    <Center py="xl" aria-live="polite">
      <Loader size="sm" aria-label="Loading page" />
    </Center>
  );
}

/** Guards every signed-in page; sends the user to sign in (remembering where they were). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoader />;
  if (status !== 'authenticated') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={status === 'mfa' ? `/mfa?next=${next}` : status === 'enrol' ? `/mfa/setup?next=${next}` : `/login?next=${next}`} replace />;
  }
  if (me?.mustChangePassword && location.pathname !== '/change-password') return <Navigate to={`/change-password?next=${encodeURIComponent(location.pathname)}`} replace />;
  return (
    <>
      {children}
      {API_MODE === 'mock' && (
        <Suspense fallback={null}>
          <MockPanel />
        </Suspense>
      )}
    </>
  );
}

interface AlertItem {
  label: string;
  to: string;
  count: number;
}

/** "Alerts · n": things waiting for this user (only what their role can act on). */
function useAlerts(): AlertItem[] {
  const { can } = useAuth();
  const adj = useQuery({
    queryKey: ['alerts', 'adjustments'],
    queryFn: () => api.get<unknown>('/adjustments', { query: { status: 'pending' } }).then((r) => listOf(r).length),
    enabled: can('adjustments:approve'),
    staleTime: 60_000,
  });
  const msgs = useQuery({
    queryKey: ['alerts', 'messages'],
    queryFn: () => api.get<unknown>('/messages').then((r) => listOf<{ status?: string }>(r).filter((m) => m.status === 'awaiting_approval').length),
    enabled: can('messages:bulk_approve'),
    staleTime: 60_000,
  });
  const wd = useQuery({
    queryKey: ['alerts', 'withdrawals'],
    queryFn: () => api.get<unknown>('/withdrawals').then((r) => listOf<{ status?: string }>(r).filter((w) => w.status === 'pending_clearance' || w.status === 'pending').length),
    enabled: can('withdrawals:update'),
    staleTime: 60_000,
  });
  return [
    { label: 'Discounts waiting for approval', to: '/finance/adjustments', count: adj.data ?? 0 },
    { label: 'Bulk messages waiting for approval', to: '/messages', count: msgs.data ?? 0 },
    { label: 'Withdrawals waiting for clearance', to: '/withdrawals', count: wd.data ?? 0 },
  ].filter((a) => a.count > 0);
}

function AlertsButton({ phone }: { phone?: boolean }) {
  const alerts = useAlerts();
  const total = alerts.reduce((a, x) => a + x.count, 0);
  return (
    <Popover position="bottom-end" withArrow shadow="md" width={280}>
      <Popover.Target>
        {phone ? (
          <button type="button" className="k-round" aria-label={`Alerts: ${total}`}>
            {total}
          </button>
        ) : (
          <Button variant="default" size="md" aria-label={`Alerts: ${total}`}>
            Alerts · {total}
          </Button>
        )}
      </Popover.Target>
      <Popover.Dropdown>
        {alerts.length === 0 ? (
          <Text size="sm">Nothing is waiting for you.</Text>
        ) : (
          <Stack gap={4}>
            {alerts.map((a) => (
              <Text key={a.to} component={Link} to={a.to} size="sm" c="navy.7">
                {a.label} · <b>{a.count}</b>
              </Text>
            ))}
          </Stack>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

function isActive(items: NavItem[], pathname: string, to: string) {
  if (to === '/') return pathname === '/';
  if (!(pathname === to || pathname.startsWith(`${to}/`))) return false;
  // A longer matching item wins (e.g. "Record payment" over "Receipts").
  return !items.some((i) => i.to !== to && i.to.length > to.length && (pathname === i.to || pathname.startsWith(`${i.to}/`)));
}

export function AppLayout() {
  const { me, logout, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, more] = useDisclosure();
  const [findOpen, find] = useDisclosure();
  const items = useMemo(() => visibleNav(me?.permissions ?? []), [me]);
  const tabs = useMemo(() => phoneTabs(me?.permissions ?? []), [me]);
  const groups = useMemo(() => {
    const m = new Map<string, NavItem[]>();
    for (const i of items) m.set(i.group, [...(m.get(i.group) ?? []), i]);
    return [...m.entries()];
  }, [items]);
  const roles = (me?.roles ?? []).map((r) => ROLE_LABELS[r as Role] ?? r).join(', ');
  const tabActive = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`));
  const navLinks = (onClick?: () => void) =>
    groups.map(([group, list]) => (
      <div key={group}>
        {group !== 'Main' && <div className="k-nav-group">{group}</div>}
        {list.map((i) => (
          <Link key={i.to} to={i.to} onClick={onClick} aria-current={isActive(items, location.pathname, i.to) ? 'page' : undefined}>
            {i.label}
          </Link>
        ))}
      </div>
    ));

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <aside className="k-sidebar">
        <Link to="/" className="k-wordmark">
          Kansview
        </Link>
        <nav className="k-nav" aria-label="Main menu">
          {navLinks()}
        </nav>
        <div className="k-user">
          <div>
            {me?.fullName} · {roles}
          </div>
          <button type="button" onClick={() => navigate('/change-password')}>
            Change password
          </button>
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="k-body">
        <header className="k-topbar">
          <GlobalSearch />
          {can('emergency_view:read') && (
            <Button color="red" size="md" component={Link} to="/emergency">
              Emergency
            </Button>
          )}
          <AlertsButton />
        </header>
        <header className="k-phonebar">
          {location.pathname !== '/' && (
            <button type="button" className="k-round" aria-label="Back" onClick={() => navigate(-1)}>
              ‹
            </button>
          )}
          <h1 aria-live="polite">{titleFor(location.pathname)}</h1>
          <button type="button" className="k-round" onClick={find.open}>
            Find
          </button>
          <AlertsButton phone />
        </header>
        <OfflineBanner />
        <main id="main" className="k-main" tabIndex={-1}>
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <nav className="k-tabbar" aria-label="Phone menu">
        {tabs.map((t) => (
          <Link key={t.label} to={t.to} aria-current={tabActive(t.to) ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
        <button type="button" onClick={more.open} aria-haspopup="dialog">
          More
        </button>
      </nav>
      {can('emergency_view:read') && !location.pathname.includes('/emergency') && (
        <Link to="/emergency" className="k-fab">
          Emergency
        </Link>
      )}

      <Drawer opened={moreOpen} onClose={more.close} position="bottom" size="85%" title={<Text fw={600}>{me?.fullName} · {roles}</Text>}>
        <nav className="k-more" aria-label="All menu items">
          {items.map((i) => (
            <Link key={i.to} to={i.to} onClick={more.close}>
              {i.label}
            </Link>
          ))}
          <Link to="/change-password" onClick={more.close}>
            Change password
          </Link>
        </nav>
        <Button mt="md" variant="default" fullWidth size="md" onClick={() => void logout()}>
          Sign out
        </Button>
      </Drawer>
      <Modal opened={findOpen} onClose={find.close} title="Find" fullScreen>
        <div onClick={(e) => (e.target as HTMLElement).closest('[role="option"]') && find.close()}>
          <GlobalSearch autoFocus />
        </div>
      </Modal>
    </>
  );
}

export function NotFoundPage() {
  return (
    <Center py="xl">
      <div>
        <Text fw={700} size="lg">
          Page not found
        </Text>
        <Text c="dimmed" mb="sm">
          The link may be old, or you may not have access to this record.
        </Text>
        <Button component={Link} to="/">
          Go to the dashboard
        </Button>
      </div>
    </Center>
  );
}

/** Shown instead of a blank page if a screen crashes. */
export function RouteError() {
  return (
    <Center py="xl" px="md">
      <div>
        <Text fw={700} size="lg">
          Something went wrong on this page
        </Text>
        <Text c="dimmed" mb="sm">
          Nothing you saved before is lost. Reload the page; if it happens again, tell the administrator what you were doing.
        </Text>
        <Group>
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="default" component="a" href="/">
            Go to the dashboard
          </Button>
        </Group>
      </div>
    </Center>
  );
}
