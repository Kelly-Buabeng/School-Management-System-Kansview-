import { AppShell, Burger, Button, Center, Group, Loader, Menu, NavLink, ScrollArea, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { API_MODE } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { ROLE_LABELS, type Role } from '@/auth/permissions';
import { initials } from '@/lib/format';
import { GlobalSearch } from './GlobalSearch';
import { visibleNav, type NavItem } from './nav';
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

export function AppLayout() {
  const { me, logout } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const navigate = useNavigate();
  const items = useMemo(() => visibleNav(me?.permissions ?? []), [me]);
  const groups = useMemo(() => {
    const m = new Map<string, NavItem[]>();
    for (const i of items) m.set(i.group, [...(m.get(i.group) ?? []), i]);
    return [...m.entries()];
  }, [items]);
  const isActive = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname === to || (location.pathname.startsWith(`${to}/`) && !items.some((i) => i.to !== to && i.to.startsWith(to) && location.pathname.startsWith(i.to))));

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 240, breakpoint: 'md', collapsed: { mobile: !opened } }} padding="md">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <AppShell.Header zIndex={250}>
        <Group h="100%" px="sm" gap="sm" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} hiddenFrom="md" size="sm" aria-label={opened ? 'Close menu' : 'Open menu'} />
          <Text component={Link} to="/" fw={800} c="blue.8" visibleFrom="sm" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
            Kansview
          </Text>
          <GlobalSearch />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <UnstyledButton aria-label="Account menu" ml="auto" style={{ flexShrink: 0 }}>
                <Group gap={6} wrap="nowrap">
                  <Center w={34} h={34} bg="blue.8" c="white" style={{ borderRadius: '50%', fontWeight: 700, fontSize: 13 }}>
                    {initials(me?.fullName ?? '?')}
                  </Center>
                  <div style={{ lineHeight: 1.1 }}>
                    <Text size="sm" fw={600} visibleFrom="sm">
                      {me?.fullName}
                    </Text>
                    <Text size="xs" c="dimmed" visibleFrom="sm">
                      {(me?.roles ?? []).map((r) => ROLE_LABELS[r as Role] ?? r).join(', ')}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{me?.fullName}</Menu.Label>
              <Menu.Item onClick={() => navigate('/change-password')}>Change password</Menu.Item>
              <Menu.Item color="red" onClick={() => void logout()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" aria-label="Main menu">
        <ScrollArea type="auto">
          <div>
            {groups.map(([group, list]) => (
              <div key={group}>
                {group !== 'Main' && (
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" mt="sm" mb={2}>
                    {group}
                  </Text>
                )}
                {list.map((i) => (
                  <NavLink key={i.to} component={Link} to={i.to} label={i.label} active={isActive(i.to)} onClick={close} aria-current={isActive(i.to) ? 'page' : undefined} />
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main id="main" tabIndex={-1}>
        <div style={{ margin: 'calc(-1 * var(--mantine-spacing-md)) calc(-1 * var(--mantine-spacing-md)) var(--mantine-spacing-md)' }}>
          <OfflineBanner />
        </div>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </AppShell.Main>
    </AppShell>
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
