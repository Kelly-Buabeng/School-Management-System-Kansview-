import { z } from 'zod';
import { isIsoDate } from '@sms/shared';
import { ADJUSTMENT_TYPES, PAYMENT_METHODS } from './domain/types';
import { AppError } from '../../common/app-error';

const uuid = z.uuid();
const isoDate = z.string().refine(isIsoDate, 'Use the date format YYYY-MM-DD');
const pesewas = z.number().int().safe();
const positivePesewas = pesewas.min(1);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Path ids: anything that is not a UUID is simply "not found" (never a 500, never a hint). */
export function parseId(value: string, what = 'record'): string {
  const r = uuid.safeParse(value);
  if (!r.success) throw AppError.notFound(what);
  return r.data;
}

export const FEE_CATEGORIES = ['tuition', 'pta', 'feeding', 'transport', 'uniform', 'books', 'exams', 'extracurricular', 'other'] as const;

export const CreateFeeItemBody = z.strictObject({
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only'),
  name: text(100),
  category: z.enum(FEE_CATEGORIES),
  isOptional: z.boolean().default(false),
  allocationPriority: z.number().int().min(0).max(1000).default(100),
});
export const UpdateFeeItemBody = z.strictObject({
  name: text(100).optional(),
  category: z.enum(FEE_CATEGORIES).optional(),
  isOptional: z.boolean().optional(),
  isActive: z.boolean().optional(),
  allocationPriority: z.number().int().min(0).max(1000).optional(),
});

const StructureLine = z.strictObject({
  feeItemId: uuid,
  amountPesewas: pesewas.min(0),
  isOptional: z.boolean().optional(),
});

export const CreateFeeStructureBody = z.strictObject({
  termId: uuid,
  levelId: uuid,
  classId: uuid.nullable().optional(),
  name: text(120),
  lines: z.array(StructureLine).max(50).optional(),
  /** Copy the lines of an existing structure (e.g. last term's) instead of typing them again. */
  copyFromStructureId: uuid.optional(),
});
export const ReplaceFeeStructureLinesBody = z.strictObject({
  name: text(120).optional(),
  lines: z.array(StructureLine).max(50),
});
export const ListFeeStructuresQuery = z.strictObject({ termId: uuid.optional() });

export const SetOptionalItemsBody = z.strictObject({
  termId: uuid,
  items: z.array(z.strictObject({ feeItemId: uuid, optedIn: z.boolean() })).max(50),
});

export const GenerateInvoicesBody = z.strictObject({
  termId: uuid,
  scope: z.strictObject({
    type: z.enum(['student', 'class', 'level', 'school']),
    ids: z.array(uuid).max(2000).optional(),
  }),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  dryRun: z.boolean().default(true),
});
export const ListInvoicesQuery = z.strictObject({
  termId: uuid.optional(),
  classId: uuid.optional(),
  studentId: uuid.optional(),
  status: z.enum(['issued', 'void']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const VoidInvoiceBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });

export const RecordPaymentBody = z.strictObject({
  studentId: uuid,
  payerGuardianId: uuid.optional(),
  payerName: z.string().trim().max(120).optional(),
  amountPesewas: positivePesewas,
  method: z.enum(PAYMENT_METHODS),
  referenceNo: z.string().max(64).optional(),
  bankName: z.string().trim().max(100).optional(),
  chequeNo: z.string().trim().max(50).optional(),
  receivedAt: z.iso.datetime({ offset: true }),
  notes: z.string().trim().max(500).optional(),
  allocations: z.array(z.strictObject({ invoiceLineId: uuid, amountPesewas: positivePesewas })).max(100).optional(),
  confirmDuplicate: z.boolean().optional(),
  duplicateOverrideReason: z.string().trim().max(300).optional(),
});
export type RecordPaymentBody = z.infer<typeof RecordPaymentBody>;

export const DuplicateCheckQuery = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  referenceNo: z.string().min(1).max(64),
});
export const ListPaymentsQuery = z.strictObject({
  from: isoDate.optional(),
  to: isoDate.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  studentId: uuid.optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const ReversePaymentBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });
export const ReallocatePaymentBody = z.strictObject({
  allocations: z.array(z.strictObject({ invoiceLineId: uuid, amountPesewas: positivePesewas })).max(100),
});

export const AdjustmentBody = z.strictObject({
  studentId: uuid,
  termId: uuid,
  type: z.enum(ADJUSTMENT_TYPES),
  feeItemId: uuid.optional(),
  amountPesewas: positivePesewas.optional(),
  percentBasisPoints: z.number().int().min(1).max(10000).optional(),
  reason: z.string().trim().min(5).max(500),
});
export type AdjustmentBody = z.infer<typeof AdjustmentBody>;
export const ListAdjustmentsQuery = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected', 'reversed']).optional(),
  studentId: uuid.optional(),
});
export const DecideAdjustmentBody = z.strictObject({ reason: z.string().trim().max(500).optional() });
export const ReverseAdjustmentBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });

export const ClassBalancesQuery = z.strictObject({ termId: uuid.optional() });
export const StatementQuery = z.strictObject({ from: isoDate.optional(), to: isoDate.optional() });

const byMethod = z.strictObject(Object.fromEntries(PAYMENT_METHODS.map((m) => [m, pesewas.min(0).optional()])) as Record<(typeof PAYMENT_METHODS)[number], z.ZodOptional<z.ZodNumber>>);
export const OpenCashUpBody = z.strictObject({ businessDate: isoDate.optional(), notes: z.string().trim().max(500).optional() });
export const CloseCashUpBody = z.strictObject({ countedByMethod: byMethod, notes: z.string().trim().max(1000).optional() });

const format = z.enum(['json', 'xlsx', 'pdf']).default('json');
export const CollectionsQuery = z.strictObject({
  groupBy: z.enum(['day', 'term', 'method', 'class', 'fee_item']).default('day'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  format,
});
export const AgingQuery = z.strictObject({ format });
export const DefaultersQuery = z.strictObject({
  minOutstandingPesewas: z.coerce.number().int().min(0).optional(),
  classId: uuid.optional(),
  format,
});
export const DailyCashUpQuery = z.strictObject({ date: isoDate, format });
export const ReconciliationQuery = z.strictObject({ from: isoDate.optional(), to: isoDate.optional(), format });
