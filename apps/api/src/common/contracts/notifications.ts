export type TemplateCode = 'fee_reminder' | 'absence_alert' | 'announcement' | 'closure_notice' | 'emergency' | 'password_reset';

export interface NotificationRecipient {
  guardianId?: string;
  studentId?: string;
  staffUserId?: string;
  phone: string; // E.164
}

export interface EnqueueOptions {
  channel?: 'sms' | 'whatsapp';
  /** Prevents duplicates, e.g. `absence:${studentId}:${date}`. */
  dedupeKey?: string;
  requestedByUserId?: string | null;
  scheduledFor?: string;
}

/** Queue a templated message. Never sends synchronously; survives restarts (pg-boss). Owner: Agent F. */
export interface NotificationService {
  enqueue(template: TemplateCode, recipients: NotificationRecipient[], context: Record<string, string | number>, opts?: EnqueueOptions): Promise<{ messageId: string }>;
}
export const NOTIFICATION_SERVICE = Symbol('NOTIFICATION_SERVICE');
