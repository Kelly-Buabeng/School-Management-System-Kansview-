// Owner: Agent B. Strict request schemas for guardians and student–guardian links.
import { z } from 'zod';
import { PageQuery } from '../../common/pagination';
import { zGhanaPhone, zUuid } from '../settings/common/http';

export const RELATIONSHIPS = ['mother', 'father', 'grandparent', 'aunt', 'uncle', 'sibling', 'guardian', 'other'] as const;
export const zRelationship = z.enum(RELATIONSHIPS);

/** Ghana Card: GHA-123456789-0 (accepts lower case and missing hyphens). */
export const zGhanaCard = z.string().trim().toUpperCase()
  .transform((v) => v.replace(/\s/g, ''))
  .transform((v) => (/^GHA\d{10}$/.test(v) ? `GHA-${v.slice(3, 12)}-${v.slice(12)}` : v))
  .pipe(z.string().regex(/^GHA-\d{9}-\d$/, 'Ghana Card numbers look like GHA-123456789-0'));

const opt = (max: number) => z.string().trim().max(max).optional();

export const GuardianInput = z.strictObject({
  title: opt(20),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phonePrimary: zGhanaPhone,
  phoneSecondary: zGhanaPhone.optional(),
  whatsappNumber: zGhanaPhone.optional(),
  email: z.string().trim().email().max(150).optional(),
  occupation: opt(100),
  workplace: opt(150),
  homeAddress: opt(300),
  workAddress: opt(300),
  ghanaCardNumber: zGhanaCard.optional(),
});
export type GuardianInput = z.infer<typeof GuardianInput>;

export const UpdateGuardianBody = z.strictObject({
  title: z.string().trim().max(20).nullable().optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phonePrimary: zGhanaPhone.optional(),
  phoneSecondary: zGhanaPhone.nullable().optional(),
  whatsappNumber: zGhanaPhone.nullable().optional(),
  email: z.string().trim().email().max(150).nullable().optional(),
  occupation: z.string().trim().max(100).nullable().optional(),
  workplace: z.string().trim().max(150).nullable().optional(),
  homeAddress: z.string().trim().max(300).nullable().optional(),
  workAddress: z.string().trim().max(300).nullable().optional(),
  ghanaCardNumber: zGhanaCard.nullable().optional(),
});
export type UpdateGuardianBody = z.infer<typeof UpdateGuardianBody>;

export const LinkFlags = {
  isPrimary: z.boolean().optional(),
  isFeePayer: z.boolean().optional(),
  canPickUp: z.boolean().optional(),
  receivesSms: z.boolean().optional(),
  livesWithStudent: z.boolean().optional(),
};

export const GuardianLinkInput = z.strictObject({
  guardianId: zUuid.optional(),
  newGuardian: GuardianInput.optional(),
  relationship: zRelationship,
  ...LinkFlags,
}).refine((g) => !!g.guardianId !== !!g.newGuardian, { message: 'Choose an existing guardian or enter a new one (not both)', path: ['guardianId'] });
export type GuardianLinkInput = z.infer<typeof GuardianLinkInput>;

export const UpdateLinkBody = z.strictObject({ relationship: zRelationship.optional(), ...LinkFlags });
export type UpdateLinkBody = z.infer<typeof UpdateLinkBody>;

export const ListGuardiansQuery = PageQuery.extend({ q: z.string().trim().max(100).optional(), phone: z.string().trim().max(20).optional() });

export const RevealBody = z.strictObject({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) });

export const MergeGuardiansBody = z.strictObject({
  keepGuardianId: zUuid,
  mergeGuardianId: zUuid,
  reason: z.string().trim().min(5).max(300),
});
