import type { AuthUser } from './auth-user';

export type AuditAction =
  | 'view' | 'create' | 'update' | 'delete' | 'archive' | 'export'
  | 'login' | 'login_failed' | 'logout' | 'emergency_view' | 'reveal_sensitive'
  | 'approve' | 'reverse';

export interface AuditEvent {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  studentId?: string | null;
  /** Field-level before/after. Sensitive values must already be masked by the caller or by AuditService. */
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  reason?: string | null;
}

/**
 * Append-only audit writer. `tx` lets the event commit in the same transaction as the business change.
 * Real implementation: Agent D (audit.events with hash chain).
 */
export interface AuditService {
  record(event: AuditEvent, actor: AuthUser | null, tx?: unknown): Promise<void>;
}
export const AUDIT_SERVICE = Symbol('AUDIT_SERVICE');
