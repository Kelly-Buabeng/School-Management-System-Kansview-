// Owner: Agent F. Pluggable SMS provider contract.

export type ProviderSendStatus = 'sent' | 'delivered' | 'failed';

export interface ProviderSendResult {
  providerMessageId: string | null;
  status: ProviderSendStatus;
  /** Billing units charged by the provider (usually = SMS segments). */
  costUnits: number;
  /** Provider response code, stored on delivery_attempts. */
  responseCode?: string;
  error?: string;
  /** true when retrying cannot help (invalid number, blacklisted, insufficient credit is NOT permanent). */
  permanent?: boolean;
}

export interface MessageProvider {
  /** Short name stored on delivery_attempts.provider. */
  readonly name: string;
  /** `to` is E.164 (+233...). Must not throw for ordinary delivery failures; return status 'failed' instead. */
  send(to: string, body: string): Promise<ProviderSendResult>;
  getStatus(providerMessageId: string): Promise<{ status: ProviderSendStatus | 'unknown'; deliveredAt?: string }>;
}
export const MESSAGE_PROVIDER = Symbol('MESSAGE_PROVIDER');
