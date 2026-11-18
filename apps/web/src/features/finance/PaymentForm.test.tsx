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
  await user.click(screen.getByRole('textbox', { name: /How was it paid/ }));
  await user.click(await screen.findByRole('option', { name: label, hidden: true }));
}

describe('payment form', () => {
  it('warns as the bursar types a used MoMo reference, then needs a reason to override the 409', async () => {
    const { onSaved, user } = setup();
    await screen.findByText(/What does this payment cover/);
    await user.type(screen.getByLabelText(/Amount received/), '150');
    await chooseMethod(user, 'MTN Mobile Money');
    await user.type(screen.getByLabelText(/Transaction ID/), KNOWN.momoReference);
    expect(await screen.findByText('This reference number was already used')).toBeInTheDocument();

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
    await user.type(await screen.findByLabelText(/Amount received/), '20');
    await chooseMethod(user, 'Bank transfer / deposit');
    await user.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText(/Enter the reference number/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('when the reply is lost, says "Not sure it saved", never "Saved", and finds it by idempotency key', async () => {
    const { user, onSaved, student } = setup();
    const before = getDb().payments.filter((p) => p.studentId === student.id).length;
    await user.type(await screen.findByLabelText(/Amount received/), '75.50');
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
    await user.type(await screen.findByLabelText(/Amount received/), '40');
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
