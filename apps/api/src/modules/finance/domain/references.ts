import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../../common/app-error';
import type { PaymentMethod } from './types';

/** Every method except cash needs a reference (MoMo transaction id, bank slip number, cheque number). */
export function requiresReference(method: PaymentMethod): boolean {
  return method !== 'cash';
}

/** Removes all whitespace and upper-cases. "  61 234 567 890 " → "61234567890". */
export function cleanReference(ref: string): string {
  return ref.replace(/\s+/g, '').toUpperCase();
}

/**
 * Normalised key used for duplicate warnings: `method:UPPER(TRIM(ref))` with inner spaces removed.
 * Returns null when there is no usable reference (cash without reference).
 */
export function referenceKey(method: PaymentMethod, ref: string | null | undefined): string | null {
  if (ref == null) return null;
  const cleaned = cleanReference(ref);
  if (cleaned === '') return null;
  return `${method}:${cleaned}`;
}

/** Validates the reference rule and returns the cleaned reference (or null for cash with none). */
export function validateReference(method: PaymentMethod, ref: string | null | undefined): string | null {
  const cleaned = ref == null ? '' : cleanReference(ref);
  if (cleaned === '') {
    if (requiresReference(method)) {
      throw new AppError(
        422,
        ErrorCodes.PAYMENT_REFERENCE_REQUIRED,
        'Please enter the reference number',
        `A reference number is required for ${methodLabel(method)} payments.`,
        [{ field: 'referenceNo', code: 'REQUIRED', message: 'Reference number is required for this payment method' }],
      );
    }
    return null;
  }
  return cleaned;
}

export function methodLabel(method: PaymentMethod): string {
  switch (method) {
    case 'cash': return 'cash';
    case 'bank_transfer': return 'bank transfer';
    case 'cheque': return 'cheque';
    case 'momo_mtn': return 'MTN MoMo';
    case 'telecel_cash': return 'Telecel Cash';
    case 'at_money': return 'AT Money';
  }
}
