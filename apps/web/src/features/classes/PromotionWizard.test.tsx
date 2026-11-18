import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { currentEnrolment, getDb } from '@/mocks/db';
import { renderRoute, signInAs } from '@/test/render';
import PromotionWizard from './PromotionWizard';

describe('promotion wizard', () => {
  it('needs a reason for an exception, shows it in the summary, commits, and offers undo', async () => {
    signInAs('admin');
    const user = userEvent.setup();
    renderRoute(<PromotionWizard />);
    await user.click(await screen.findByRole('textbox', { name: 'Into year' }));
    await user.click(await screen.findByRole('option', { name: '2027/2028', hidden: true }));
    await user.click(await screen.findByLabelText(/^Basic 2 \(/));
    await user.click(screen.getByRole('button', { name: /Build preview/ }));

    const kwameRow = (await screen.findByText('Kwame Agyei Mensah')).closest('tr')!;
    const actionInput = within(kwameRow).getByRole('textbox', { name: /What happens to Kwame/ });
    await user.click(actionInput);
    await waitFor(() => expect(actionInput.getAttribute('aria-controls')).toBeTruthy());
    const listbox = document.getElementById(actionInput.getAttribute('aria-controls')!)!;
    await user.click(within(listbox).getByRole('option', { name: 'Repeat the class', hidden: true }));
    const apply = within(kwameRow).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled(); // no reason yet
    expect(await screen.findByText(/1 student\(s\) have a change that is not applied yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next: confirm' })).toBeDisabled();
    const row2 = kwameRow;
    await user.type(within(row2).getByRole('textbox', { name: /Reason for Kwame/ }), 'Missed most of term 3 through illness');
    await user.click(within(row2).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(getDb().promotionRuns[0]!.items.find((i) => i.student.fullName === 'Kwame Agyei Mensah')!.overrideReason).toMatch(/illness/));

    await user.click(screen.getByRole('button', { name: 'Next: confirm' }));
    expect(await screen.findByTestId('count-repeat')).toHaveTextContent('1');
    expect(screen.getByTestId('count-promote')).toHaveTextContent('9');
    await user.click(screen.getByRole('button', { name: 'Commit promotion' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Commit promotion' }));

    expect(await screen.findByText('Promotion committed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Undo until/ })).toBeInTheDocument();
    const kwame = getDb().students.find((s) => s.firstName === 'Kwame' && s.lastName === 'Mensah')!;
    const cls = getDb().classes.find((c) => c.id === currentEnrolment(getDb(), kwame.id)!.classId)!;
    expect(cls.name).toBe('Basic 2'); // repeats: same level, next year
    expect(getDb().years.find((y) => y.id === cls.academicYearId)!.name).toBe('2027/2028');
  });
});
