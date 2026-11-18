// Owner: Agent F.
/**
 * WhatsApp channel: INTERFACE STUB (not wired in v1).
 *
 * WhatsApp Business messages outside a 24-hour customer window must use pre-approved templates with positional
 * parameters, so a WhatsApp channel maps our template code + context to the provider's approved template name and
 * ordered parameters instead of sending free text. messages.channel = 'whatsapp' is accepted by the schema; the
 * send endpoint currently refuses it with a plain message until an adapter exists.
 */
export interface WhatsAppTemplateMessage {
  to: string; // E.164
  /** Name of the template approved in WhatsApp Business Manager, e.g. 'fee_reminder_v1'. */
  templateName: string;
  languageCode: string; // 'en'
  parameters: string[];
}

export interface WhatsAppChannel {
  readonly name: string;
  sendTemplate(msg: WhatsAppTemplateMessage): Promise<{ providerMessageId: string | null; status: 'sent' | 'failed'; error?: string; permanent?: boolean }>;
}
export const WHATSAPP_CHANNEL = Symbol('WHATSAPP_CHANNEL');
