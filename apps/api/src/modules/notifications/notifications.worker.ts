// Owner: Agent F. Starts queue handlers in the worker process only (SMS_PROCESS_ROLE=worker, see apps/api/src/worker.ts).
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DeliveryProcessor } from './delivery.processor';
import { BossService, isWorkerProcess, SMS_SEND_QUEUE, type SmsSendJob } from './queue/boss.service';

export class RetryableDeliveryError extends Error {
  constructor(recipientId: string) {
    super(`temporary SMS failure for recipient ${recipientId}; the queue will retry`);
    this.name = 'RetryableDeliveryError';
  }
}

@Injectable()
export class NotificationsWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('NotificationsWorker');
  private started = false;

  constructor(
    private readonly boss: BossService,
    private readonly processor: DeliveryProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (isWorkerProcess()) await this.start();
  }

  /** Registers the SMS handler. Public so tests can start a worker inside a test app. */
  async start(opts: { pollingIntervalSeconds?: number } = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    const boss = await this.boss.get();
    await boss.work<SmsSendJob>(
      SMS_SEND_QUEUE,
      { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
      async ([job]) => {
        if (!job) return;
        const outcome = await this.processor.process(job.data.recipientId, job.retryCount + 1);
        if (outcome === 'retry') throw new RetryableDeliveryError(job.data.recipientId);
        return { outcome };
      },
    );
    this.logger.log('SMS queue worker started');
  }
}
