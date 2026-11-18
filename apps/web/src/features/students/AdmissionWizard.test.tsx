import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { renderRoute, signInAs } from '@/test/render';
import AdmissionWizard from './AdmissionWizard';

async function fillChild(user: ReturnType<typeof userEvent.setup>, first: string, last: string, dob: string) {
  await user.type(screen.getByLabelText(/First name/), first);
  await user.type(screen.getByLabelText(/^Surname/), last);
  fireEvent.change(screen.getByLabelText(/Date of birth/), { target: { value: dob } });
  await user.click(screen.getByLabelText('Male'));
  await user.click(screen.getByRole('textbox', { name: /Class/ }));
  await user.click(await screen.findByRole('option', { name: /Basic 3/, hidden: true }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

async function addParent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Add a new parent/ }));
  const card = screen.getByText('New parent or guardian').closest('.mantine-Card-root') as HTMLElement;
  await user.type(within(card).getByLabelText(/First name/), 'Esi');
  await user.type(within(card).getByLabelText(/^Surname/), 'Tetteh');
  await user.type(within(card).getByLabelText(/^Phone/), '024 000 5555');
  await user.type(within(card).getByLabelText(/Relationship/), 'Mother');
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('admission wizard', () => {
  it('shows the duplicate warning and only admits after a reason is given', async () => {
    signInAs('registrar');
    const user = userEvent.setup();
    renderRoute(<AdmissionWizard />, { path: '/students/new', url: '/students/new' });
    await screen.findByRole('heading', { name: 'Admit a student' });
    await fillChild(user, 'Kwame', 'Mensah', '2018-03-12');
    await addParent(user);
    await user.click(await screen.findByRole('button', { name: 'Next' })); // medical (optional)
    await screen.findByText(/call these people in this order/);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Admit student' }));

    const dialog = await screen.findByRole('dialog', { name: /may already be registered/ });
    expect(within(dialog).getByText(/KSV-23-/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Admit as a different child' });
    expect(confirm).toBeDisabled();
    const before = getDb().students.length;
    await user.type(within(dialog).getByLabelText(/explain why/), 'Different parents, different town');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await screen.findByText('other page'); // navigated to the new student's profile
    expect(getDb().students.length).toBe(before + 1);
    expect(getDb().audit[0]!.summary).toContain('duplicate warning overridden');
  });

  it('blocks moving on when required child details are missing', async () => {
    signInAs('registrar');
    const user = userEvent.setup();
    renderRoute(<AdmissionWizard />, { path: '/students/new', url: '/students/new' });
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter the first name')).toBeInTheDocument();
    expect(screen.getByText('Choose a class')).toBeInTheDocument();
  });

  it('admits a new child without any warning', async () => {
    signInAs('registrar');
    const user = userEvent.setup();
    renderRoute(<AdmissionWizard />, { path: '/students/new', url: '/students/new' });
    await screen.findByRole('heading', { name: 'Admit a student' });
    await fillChild(user, 'Yaa', 'Gyamfi', '2017-05-20');
    await addParent(user);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Admit student' }));
    await screen.findByText('other page');
    await waitFor(() => expect(getDb().students.some((s) => s.firstName === 'Yaa' && s.lastName === 'Gyamfi')).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
