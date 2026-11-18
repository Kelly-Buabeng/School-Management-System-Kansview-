// Owner: Agent F. Strict request schemas for the `messages` OpenAPI tag.
import { z } from 'zod';
import { PageQuery } from '../../common/pagination';
import { MAX_TEMPLATE_LENGTH } from './template-engine';

export const MESSAGE_KINDS = ['fee_reminder', 'absence_alert', 'announcement', 'closure_notice', 'emergency'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const CreateTemplateBody = z.strictObject({
  code: z.enum(MESSAGE_KINDS),
  channel: z.enum(['sms', 'whatsapp']).default('sms'),
  name: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(MAX_TEMPLATE_LENGTH),
  isActive: z.boolean().default(true),
});

export const UpdateTemplateBody = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  body: z.string().trim().min(1).max(MAX_TEMPLATE_LENGTH).optional(),
  isActive: z.boolean().optional(),
});

export const AudienceSchema = z.strictObject({
  type: z.enum(['students', 'guardians', 'class', 'level', 'school', 'defaulters']),
  ids: z.array(z.uuid()).max(2000).optional(),
  primaryGuardianOnly: z.boolean().default(true),
});

/** SendMessageRequest (openapi) plus optional `variables` for non-system placeholders such as {{message}} or {{dueDate}}. */
export const SendMessageBody = z.strictObject({
  kind: z.enum(MESSAGE_KINDS),
  channel: z.enum(['sms', 'whatsapp']).default('sms'),
  templateId: z.uuid().optional(),
  body: z.string().trim().min(1).max(MAX_TEMPLATE_LENGTH).optional(),
  audience: AudienceSchema,
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
  variables: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.string().max(300)).optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const ListMessagesQuery = PageQuery.extend({
  status: z.enum(['draft', 'pending_approval', 'queued', 'sending', 'done', 'partially_failed', 'cancelled']).optional(),
  kind: z.string().max(40).optional(),
});

export const ListRecipientsQuery = PageQuery.extend({
  status: z.enum(['queued', 'sent', 'delivered', 'failed', 'skipped_opt_out']).optional(),
});
