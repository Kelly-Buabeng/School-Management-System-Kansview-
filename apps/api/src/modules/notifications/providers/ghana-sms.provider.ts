// Owner: Agent F.
/**
 * SKELETON for a real Ghana SMS provider (Hubtel, mNotify or Arkesel; see CR-0002 open question 4).
 * Not wired in v1: selecting it via SMS_SMS_PROVIDER fails at start-up with a clear message. No credentials,
 * no network calls live here.
 *
 * To implement:
 *  1. Read the API key from a secret file (e.g. SMS_SMS_API_KEY_FILE, via change request to config.ts); never from the DB.
 *  2. send(): POST to the provider's send endpoint with the sender ID approved by the NCA, the E.164 number
 *     and the body. Map responses:
 *       2xx accepted          → { status: 'sent', providerMessageId, costUnits: segments or provider value }
 *       invalid number / DND  → { status: 'failed', permanent: true }
 *       5xx / timeout / 429   → { status: 'failed' } (temporary; the queue retries with backoff, max 5 attempts)
 *     Use a 10 s timeout. Never log full numbers or bodies (maskPhone).
 *  3. getStatus(): call the delivery-report endpoint, or better, add a webhook route that updates
 *     message_recipients.status = 'delivered' / delivered_at (needs an OpenAPI change request).
 *  4. Add the provider host to the egress allow-list in infra/.
 */
import type { MessageProvider, ProviderSendResult, ProviderSendStatus } from './message-provider';

export class GhanaSmsProviderSkeleton implements MessageProvider {
  constructor(readonly name: 'hubtel' | 'mnotify' | 'arkesel') {}

  async send(_to: string, _body: string): Promise<ProviderSendResult> {
    return { providerMessageId: null, status: 'failed', costUnits: 0, error: `${this.name} adapter is not implemented`, permanent: true };
  }

  async getStatus(_id: string): Promise<{ status: ProviderSendStatus | 'unknown' }> {
    return { status: 'unknown' };
  }
}
