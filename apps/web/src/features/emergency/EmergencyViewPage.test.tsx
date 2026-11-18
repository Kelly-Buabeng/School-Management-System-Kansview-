import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { renderRoute, signInAs } from '@/test/render';
import EmergencyViewPage from './EmergencyViewPage';

const kwame = () => getDb().students.find((s) => s.firstName === 'Kwame' && s.lastName === 'Mensah')!;

describe('Emergency View', () => {
  it('shows the medical alert, allergies, ordered contacts with tel: links and pickups', async () => {
    signInAs('teacher'); // Kwame is in the teacher's own class
    const id = kwame().id;
    renderRoute(<EmergencyViewPage />, { path: '/students/:id/emergency', url: `/students/${id}/emergency` });
    expect(await screen.findByRole('heading', { name: 'Kwame Agyei Mensah' })).toBeInTheDocument();
    expect(screen.getByRole('alert', { name: /medical alert/i })).toHaveTextContent(/SEVERE PEANUT ALLERGY/);
    expect(screen.getByText(/Peanuts \(severe/)).toBeInTheDocument();
    const calls = screen.getAllByRole('link', { name: /^Call / });
    expect(calls[0]).toHaveAttribute('href', 'tel:+233240000100');
    expect(calls[0]).toHaveAccessibleName(/Akosua Owusu/);
    expect(screen.getByText('Yaw Darko')).toBeInTheDocument();
    expect(screen.getByAltText('Photo of Yaw Darko')).toBeInTheDocument();
    expect(getDb().audit.some((a) => a.action === 'emergency_view')).toBe(true);
  });

  it('asks for the call outcome after tapping call and logs it', async () => {
    signInAs('registrar');
    const id = kwame().id;
    const user = userEvent.setup();
    renderRoute(<EmergencyViewPage />, { path: '/students/:id/emergency', url: `/students/${id}/emergency` });
    const call = (await screen.findAllByRole('link', { name: /^Call Akosua/ }))[0]!;
    call.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot open tel:
    await user.click(call);
    const prompt = await screen.findByRole('dialog', { name: 'How did the call go?' });
    await user.click(within(prompt).getByRole('button', { name: 'No answer' }));
    await waitFor(() => expect(getDb().contactLogs.some((l) => l.outcome === 'no_answer' && l.contactName === 'Akosua Owusu')).toBe(true));
  });

  it('a teacher cannot open a child outside their class (404)', async () => {
    signInAs('teacher');
    const other = getDb().students.find((s) => s.firstName === 'Ama' && s.lastName === 'Mensah')!;
    renderRoute(<EmergencyViewPage />, { path: '/students/:id/emergency', url: `/students/${other.id}/emergency` });
    expect(await screen.findByText('We could not find that student.')).toBeInTheDocument();
  });
});
