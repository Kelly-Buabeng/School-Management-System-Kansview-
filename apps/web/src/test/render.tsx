import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { setCsrfToken } from '@/api/client';
import { AppProviders, createQueryClient } from '@/app/providers';
import type { Role } from '@/auth/permissions';
import { getDb } from '@/mocks/db';
import { newCsrf, setSession } from '@/mocks/http';

/** Signs a fake user in on the mock server (as if they had passed login + MFA). */
export function signInAs(username: string) {
  const user = getDb().users.find((u) => u.username === username);
  if (!user) throw new Error(`no mock user ${username}`);
  const csrf = newCsrf();
  setSession({ userId: user.id, stage: 'active', csrf });
  setCsrfToken(csrf);
  return user;
}

export function roleUser(role: Role) {
  return { ADMIN: 'admin', BURSAR: 'bursar', HEADTEACHER: 'head', REGISTRAR: 'registrar', TEACHER: 'teacher' }[role];
}

/** Render a page inside all providers with a memory router. */
export function renderRoute(element: ReactElement, { path = '/', url = '/', extraRoutes = [] }: { path?: string; url?: string; extraRoutes?: RouteObject[] } = {}) {
  const router = createMemoryRouter([{ path, element }, ...extraRoutes, { path: '*', element: <div>other page</div> }], { initialEntries: [url] });
  const queryClient = createQueryClient();
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router, queryClient };
}
