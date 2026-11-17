// Owner: Agent B.
import { z } from 'zod';
import { zDate, zGhanaPhone, zUuid } from '../settings/common/http';
import { EmergencyContactInput } from '../students/students.dto';

export const ReplaceContactsBody = z.union([
  z.array(EmergencyContactInput).max(10),
  z.strictObject({ contacts: z.array(EmergencyContactInput).max(10) }).transform((b) => b.contacts),
]);

export const LogContactBody = z.strictObject({
  contactRef: z.string().trim().max(100).optional(),
  phoneCalled: zGhanaPhone,
  outcome: z.enum(['reached', 'no_answer', 'wrong_number', 'message_left']),
  notes: z.string().trim().max(500).optional(),
});

const pickupFields = {
  guardianId: zUuid.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  relationship: z.string().trim().max(60).optional(),
  phone: zGhanaPhone.optional(),
  idType: z.string().trim().max(40).optional(),
  idNumberLast4: z.string().trim().regex(/^[0-9A-Za-z]{4}$/, 'Only the last 4 characters of the ID').optional(),
  verificationNotes: z.string().trim().max(300).optional(),
  validFrom: zDate.optional(),
  validTo: zDate.optional(),
};
export const CreatePickupBody = z.strictObject(pickupFields).refine((p) => !!p.guardianId || !!p.name, { message: 'Choose a guardian or enter a name', path: ['name'] });
export const UpdatePickupBody = z.strictObject({
  ...Object.fromEntries(Object.entries(pickupFields).map(([k, v]) => [k, (v as z.ZodOptional<z.ZodTypeAny>).unwrap().nullable().optional()])),
}) as unknown as z.ZodType<Partial<Record<keyof typeof pickupFields, string | null>>>;
export const ArchivePickupQuery = z.strictObject({ reason: z.string().trim().max(300).optional() });
