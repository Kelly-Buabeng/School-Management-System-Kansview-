import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { permissionsForRoles } from '@/auth/permissions';
import { renderRoute, signInAs } from '@/test/render';
import { AppLayout } from './AppLayout';
import { visibleNav } from './nav';

const labels = (roles: Parameters<typeof permissionsForRoles>[0]) => visibleNav(permissionsForRoles(roles)).map((i) => i.label);

describe('role-based navigation', () => {
  it('bursar sees finance but not users, settings, audit or admission', () => {
    const l = labels(['BURSAR']);
    expect(l).toEqual(expect.arrayContaining(['Record payment', 'Cash-up', 'Fee structures']));
    expect(l).not.toEqual(expect.arrayContaining(['Users']));
    expect(l).not.toContain('Settings');
    expect(l).not.toContain('Audit log');
    expect(l).not.toContain('Admit a student');
  });

  it('administrator does not get "Record payment" (separation of duties) but gets users and audit', () => {
    const l = labels(['ADMIN']);
    expect(l).not.toContain('Record payment');
    expect(l).toEqual(expect.arrayContaining(['Users', 'Audit log', 'Settings', 'Promotion']));
  });

  it('teacher sees only teaching items', () => {
    const l = labels(['TEACHER']);
    expect(l).toEqual(expect.arrayContaining(['Attendance', 'Score entry', 'Students']));
    for (const hidden of ['Payments', 'Messages', 'Users', 'Promotion', 'Imports', 'Staff']) expect(l).not.toContain(hidden);
  });

  it('ADMIN + BURSAR combined gets the union', () => {
    const l = labels(['ADMIN', 'BURSAR']);
    expect(l).toContain('Record payment');
    expect(l).toContain('Users');
  });

  it('renders only permitted links for the signed-in registrar', async () => {
    signInAs('registrar');
    renderRoute(<AppLayout />);
    const nav = await screen.findByRole('navigation', { name: 'Main menu' });
    expect(await within(nav).findByRole('link', { name: 'Admit a student' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });
});
