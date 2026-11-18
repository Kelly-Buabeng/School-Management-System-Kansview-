import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Payment } from '@/api/types';
import { mockControl } from '@/mocks/control';
import { getDb, KNOWN } from '@/mocks/db';
import { renderRoute, signInAs } from '@/test/render';
import { autoAllocate, PaymentForm } from './PaymentForm';

function setup() {
  signInAs('bursar');
  const student = getDb().students.find((s) => s.firstName === 'Kwame' && s.lastName === 'Mensah')!;
  const onSaved = vi.fn<(p: Payment) => void>();
  const user = userEvent.setup();
  renderRoute(<PaymentForm initialStudentId={student.id} onSaved={onSaved} />);
  return { student, onSaved, user };
}

async function chooseMethod(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('textbox', { name: /^Method/ }));
  await user.click(await screen.findByRole('option', { name: label, hidden: true }));
}

describe('payment form', () => {
  it('warns as the bursar types a used MoMo reference, then needs a reason to override the 409', async () => {
    const { onSaved, user } = setup();
    await screen.findByText(/What is this payment for/);
    await user.type(screen.getByLabelText(/Total received/), '150');
    await chooseMethod(user, 'MTN Mobile Money');
    await user.type(screen.getByLabelText(/^Reference number/), KNOWN.momoReference);
    expect(await screen.findByText(/Check this is not a repeat/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText(/was recorded on receipt RCP-/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    const saveAnyway = screen.getByRole('button', { name: 'Save anyway' });
    expect(saveAnyway).toBeDisabled();
    await user.type(screen.getByLabelText('Why is this a separate payment?'), 'Parent paid twice for two terms');
    await user.click(saveAnyway);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0]![0].receiptNo).toMatch(/^RCP-\d{6}$/);
    expect(onSaved.mock.calls[0]![0].amountPesewas).toBe(15000);
  });

  it('requires a reference for everything except cash', async () => {
    const { user, onSaved } = setup();
    await user.type(await screen.findByLabelText(/Total received/), '20');
    await chooseMethod(user, 'Bank transfer / deposit');
    await user.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText(/Enter the reference number/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('when the reply is lost, says "Not sure it saved", never "Saved", and finds it by idempotency key', async () => {
    const { user, onSaved, student } = setup();
    const before = getDb().payments.filter((p) => p.studentId === student.id).length;
    await user.type(await screen.findByLabelText(/Total received/), '75.50');
    mockControl.setMode('lose-next-save');
    await user.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText('Not sure it saved — check before trying again')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save payment' })).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    // The server did store it.
    expect(getDb().payments.filter((p) => p.studentId === student.id).length).toBe(before + 1);

    await user.click(screen.getByRole('button', { name: 'Check if it was saved' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0]![0].amountPesewas).toBe(7550);
    expect(getDb().payments.filter((p) => p.studentId === student.id).length).toBe(before + 1);
  });

  it('when offline, retrying re-uses the same Idempotency-Key so the payment is recorded once', async () => {
    const { user, onSaved, student } = setup();
    const before = getDb().payments.filter((p) => p.studentId === student.id).length;
    await user.type(await screen.findByLabelText(/Total received/), '40');
    mockControl.setMode('offline');
    await user.click(screen.getByRole('button', { name: 'Save payment' }));
    await screen.findByText('Not sure it saved — check before trying again');
    mockControl.setMode('normal');
    await user.click(screen.getByRole('button', { name: 'Check if it was saved' }));
    await user.click(await screen.findByRole('button', { name: /Not found — send it again/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const keys = getDb().payments.filter((p) => p.studentId === student.id).map((p) => p.idempotencyKey);
    expect(keys.length).toBe(before + 1);
    expect(keys.at(-1)).toMatch(/^pay-/);
  });
});

describe('per-fee allocation', () => {
  it('toggled fees with "Paying now" amounts are posted as explicit allocations; the rest becomes credit', async () => {
    const { user, onSaved, student } = setup();
    await screen.findAllByRole('switch');
    const line = screen.getAllByRole('switch').find((el) => !(el as HTMLInputElement).disabled)!;
    const feeName = line.getAttribute('aria-label')!.replace(/^Pay /, '').replace(/ \(.*$/, '');
    await user.click(line);
    const payingNow = await screen.findByLabelText('Paying now (GH₵)');
    await user.clear(payingNow);
    await user.type(payingNow, '300');
    expect(screen.getByLabelText(/Total received/)).toHaveValue('300.00');
    await user.clear(screen.getByLabelText(/Total received/));
    await user.type(screen.getByLabelText(/Total received/), '20000');
    // Typing a total re-splits across the chosen fee (capped at its balance); the rest is shown as credit.
    expect(screen.getByText('Kept as credit')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const p = getDb().payments.filter((x) => x.studentId === student.id).at(-1)!;
    expect(p.allocations).toHaveLength(1);
    expect(p.allocations[0]!.feeItemName).toBe(feeName);
    expect(p.creditCreatedPesewas).toBe(2000000 - p.allocations[0]!.amountPesewas);
  });
});

describe('autoAllocate', () => {
  it('fills oldest lines first and keeps the rest as credit (integer pesewas)', () => {
    const r = autoAllocate(
      [
        { id: 'a', label: 'Tuition', outstanding: 10000 },
        { id: 'b', label: 'Books', outstanding: 2500 },
      ],
      13001,
    );
    expect(r.lines.map((l) => l.amount)).toEqual([10000, 2500]);
    expect(r.credit).toBe(501);
  });
});
