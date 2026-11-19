// Owner: Agent F. Sends one recipient's SMS. Called by the pg-boss worker; pure enough to unit/integration test directly.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '@sms/shared';
import { KYSELY, type Db } from '../../common/db/database.module';
import { FIELD_CRYPTO } from '../../security/field-crypto';
import type { FieldCryptoEngine } from '../../security/field-crypto.service';
import { ignoresQuietHours, MessageDispatcher } from './message-dispatcher';
import { isSensitiveKind } from './notification.service';
import { MESSAGE_PROVIDER, type MessageProvider, type ProviderSendResult } from './providers/message-provider';
import { earliestSendTime, isQuietHours } from './quiet-hours';
import { BossService, SMS_MAX_ATTEMPTS } from './queue/boss.service';

/** sent | failed (final) | retry (throw so pg-boss retries with backoff) | deferred (quiet hours) | skipped (nothing to do) */
export type DeliveryOutcome = 'sent' | 'failed' | 'retry' | 'deferred' | 'skipped';

@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger('SmsDelivery');
  /** Overridable clock for tests. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
    private readonly boss: BossService,
    private readonly dispatcher: MessageDispatcher,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCryptoEngine,
  ) {}

  /**
   * @param attemptInRound 1-based attempt number of this queue job (pg-boss retryCount + 1).
   * @param sealedBody encrypted real text for messages stored redacted (password reset), from the queue job.
   */
  async process(recipientId: string, attemptInRound: number, sealedBody?: string): Promise<DeliveryOutcome> {
    await this.boss.get();
    return this.db.transaction().execute(async (tx) => {
      // Row lock: a duplicate job for the same recipient waits here, then sees status != queued and skips.
      const r = await tx.selectFrom('message_recipients as r')
        .innerJoin('messages as m', 'm.id', 'r.message_id')
        .select(['r.id', 'r.message_id', 'r.phone', 'r.body', 'r.status', 'm.kind', 'm.status as message_status'])
        .where('r.id', '=', recipientId)
        .forUpdate('r')
        .executeTakeFirst();
      if (!r || r.status !== 'queued') return 'skipped';
      if (r.message_status === 'pending_approval' || r.message_status === 'cancelled' || r.message_status === 'draft') return 'skipped';

      const now = this.now();
      if (!ignoresQuietHours(r.kind) && isQuietHours(now)) {
        // A retry or late job crossed into quiet hours: hand it to a new job at 07:00 Accra time.
        await this.boss.sendSms({ recipientId, ...(sealedBody ? { sealedBody } : {}) }, earliestSendTime(now, false), tx);
        return 'deferred';
      }

      // The stored body of a sensitive message is redacted: send the real text from the job, or nothing at all.
      let body = r.body;
      if (isSensitiveKind(r.kind)) {
        let real: string | null = null;
        try {
          real = sealedBody ? this.crypto.decrypt(Buffer.from(sealedBody, 'base64')) : null;
        } catch {
          real = null;
        }
        if (!real) {
          const error = 'The one-time code is not stored, so this message cannot be sent again. Ask for a new code.';
          await tx.updateTable('message_recipients').set({ status: 'failed', last_error: error }).where('id', '=', recipientId).execute();
          await this.dispatcher.refreshStatus(r.message_id, tx);
          return 'failed';
        }
        body = real;
      }

      const prev = await tx.selectFrom('delivery_attempts').select((eb) => eb.fn.max('attempt_no').as('n')).where('recipient_id', '=', recipientId).executeTakeFirst();
      const attemptNo = (prev?.n ?? 0) + 1;

      let result: ProviderSendResult;
      try {
        result = await this.provider.send(r.phone, body);
      } catch (err) {
        this.logger.error({ err, recipientId, to: maskPhone(r.phone) }, 'SMS provider threw');
        result = { providerMessageId: null, status: 'failed', costUnits: 0, error: err instanceof Error ? err.message : 'provider error' };
      }

      await tx.insertInto('delivery_attempts').values({
        recipient_id: recipientId,
        attempt_no: attemptNo,
        attempted_at: now,
        provider: this.provider.name,
        response_code: result.responseCode ?? null,
        error: result.status === 'failed' ? (result.error ?? 'failed') : null,
      }).execute();

      let outcome: DeliveryOutcome;
      if (result.status !== 'failed') {
        await tx.updateTable('message_recipients').set({
          status: result.status,
          provider_message_id: result.providerMessageId,
          cost_units: result.costUnits,
          sent_at: now,
          delivered_at: result.status === 'delivered' ? now : null,
          last_error: null,
        }).where('id', '=', recipientId).execute();
        outcome = 'sent';
      } else if (result.permanent || attemptInRound >= SMS_MAX_ATTEMPTS) {
        await tx.updateTable('message_recipients').set({ status: 'failed', last_error: result.error ?? 'failed' }).where('id', '=', recipientId).execute();
        this.logger.warn({ recipientId, to: maskPhone(r.phone), attemptInRound, permanent: !!result.permanent }, 'SMS failed permanently');
        outcome = 'failed';
      } else {
        await tx.updateTable('message_recipients').set({ last_error: result.error ?? 'failed' }).where('id', '=', recipientId).execute();
        outcome = 'retry';
      }
      await this.dispatcher.refreshStatus(r.message_id, tx);
      return outcome;
    });
  }
}
