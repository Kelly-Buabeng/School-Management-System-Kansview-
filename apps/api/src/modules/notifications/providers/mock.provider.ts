// Owner: Agent F. Default provider in v1: records every message in a delivery log, never touches the network.
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { maskPhone } from '@sms/shared';
import { smsInfo } from '../sms-encoding';
import type { MessageProvider, ProviderSendResult, ProviderSendStatus } from './message-provider';

export interface MockProviderOptions {
  /** 0..1 chance a send fails with a temporary error. Default 0. */
  failureRate?: number;
  /** Numbers that always fail permanently (e.g. invalid number). */
  permanentFailureNumbers?: string[];
  random?: () => number;
}

export interface MockDeliveryLogEntry {
  providerMessageId: string | null;
  to: string;
  body: string;
  status: ProviderSendStatus;
  at: string;
  error?: string;
}

export class MockProvider implements MessageProvider {
  readonly name = 'mock';
  private readonly logger = new Logger('MockSmsProvider');
  readonly deliveryLog: MockDeliveryLogEntry[] = [];
  private readonly transientFailures = new Map<string, number>();
  failureRate: number;
  readonly permanentFailureNumbers: Set<string>;
  private readonly random: () => number;

  constructor(opts: MockProviderOptions = {}) {
    this.failureRate = opts.failureRate ?? 0;
    this.permanentFailureNumbers = new Set(opts.permanentFailureNumbers ?? []);
    this.random = opts.random ?? Math.random;
  }

  /** Test hook: the next `times` sends to `phone` fail with a temporary error. */
  failNext(phone: string, times: number): void {
    this.transientFailures.set(phone, times);
  }

  reset(): void {
    this.deliveryLog.length = 0;
    this.transientFailures.clear();
    this.permanentFailureNumbers.clear();
    this.failureRate = 0;
  }

  async send(to: string, body: string): Promise<ProviderSendResult> {
    const at = new Date().toISOString();
    const units = smsInfo(body).segments;
    if (this.permanentFailureNumbers.has(to)) {
      this.deliveryLog.push({ providerMessageId: null, to, body, status: 'failed', at, error: 'invalid_number' });
      return { providerMessageId: null, status: 'failed', costUnits: 0, responseCode: '400', error: 'Number is not valid', permanent: true };
    }
    const pending = this.transientFailures.get(to) ?? 0;
    if (pending > 0 || (this.failureRate > 0 && this.random() < this.failureRate)) {
      if (pending > 0) this.transientFailures.set(to, pending - 1);
      this.deliveryLog.push({ providerMessageId: null, to, body, status: 'failed', at, error: 'temporary' });
      return { providerMessageId: null, status: 'failed', costUnits: 0, responseCode: '503', error: 'Provider temporarily unavailable' };
    }
    const providerMessageId = `mock-${randomUUID()}`;
    this.deliveryLog.push({ providerMessageId, to, body, status: 'sent', at });
    this.logger.debug(`mock SMS to ${maskPhone(to)} (${units} segment(s))`);
    return { providerMessageId, status: 'sent', costUnits: units, responseCode: '200' };
  }

  async getStatus(providerMessageId: string): Promise<{ status: ProviderSendStatus | 'unknown'; deliveredAt?: string }> {
    const e = this.deliveryLog.find((l) => l.providerMessageId === providerMessageId);
    if (!e) return { status: 'unknown' };
    return e.status === 'sent' ? { status: 'delivered', deliveredAt: e.at } : { status: e.status };
  }
}
