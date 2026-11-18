import { notifications } from '@mantine/notifications';
import { useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/ui';
import { money } from '@/lib/format';
import { PaymentForm } from './PaymentForm';

export default function RecordPaymentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Record a payment" subtitle="Cash, Mobile Money, bank or cheque received at the office." />
      <PaymentForm
        initialStudentId={params.get('studentId') ?? undefined}
        onSaved={(p) => {
          notifications.show({ color: 'green', title: `Saved — receipt ${p.receiptNo}`, message: `${money(p.amountPesewas)} recorded for ${p.studentName ?? 'the student'}.` });
          navigate(`/finance/payments/${p.id}?new=1`);
        }}
      />
    </>
  );
}
