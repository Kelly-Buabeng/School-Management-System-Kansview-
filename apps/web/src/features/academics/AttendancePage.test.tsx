import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { renderRoute, signInAs } from '@/test/render';
import AttendancePage from './AttendancePage';

describe('attendance register', () => {
  it('teacher marks one child absent with one tap and saves', async () => {
    signInAs('teacher');
    const user = userEvent.setup();
    renderRoute(<AttendancePage />, { url: '/?date=2026-11-17' });
    const group = await screen.findByRole('radiogroup', { name: /Attendance for Kwame Agyei Mensah/ });
    await user.click(within(group).getByLabelText('Absent'));
    await user.type(screen.getByLabelText(/Reason for Kwame/), 'Sick');
    expect(screen.getByText('1 absent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save register' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const basic2 = getDb().classes.find((c) => c.name === 'Basic 2' && c.academicYearId === getDb().years.find((y) => y.isCurrent)!.id)!;
    await waitFor(() => expect(getDb().attendance.get(`${basic2.id}|2026-11-17`)?.filter((e) => e.status === 'absent')).toHaveLength(1));
  });
});
