// Owner: Agent F. pg-boss wrapper shared by the API (enqueue only) and the worker (enqueue + process).
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { CompiledQuery } from 'kysely';
import PgBoss from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import type { Tx } from '../../../common/db/database.module';

export const SMS_SEND_QUEUE = 'sms-send';

/** Retry policy: 5 attempts in total (1 + 4 retries), exponential backoff from 30 s (30, 60, 120, 240 s + jitter). */
export const SMS_RETRY = { retryLimit: 4, retryDelay: 30, retryBackoff: true } as const;
export const SMS_MAX_ATTEMPTS = SMS_RETRY.retryLimit + 1;

export interface SmsSendJob {
  recipientId: string;
}

/** Process role: only the worker process (SMS_PROCESS_ROLE=worker) runs job handlers. */
export function isWorkerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SMS_PROCESS_ROLE === 'worker';
}

@Injectable()
export class BossService implements OnApplicationShutdown {
  private readonly logger = new Logger('Queue');
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Starts pg-boss lazily (creates/migrates its own `pgboss` schema) and makes sure our queues exist. */
  async get(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    if (!this.starting) {
      this.starting = (async () => {
        const boss = new PgBoss({
          connectionString: this.cfg.SMS_DB_URL,
          max: 4,
          application_name: 'sms-queue',
          // Maintenance and cron only in the worker; the API just inserts jobs.
          supervise: isWorkerProcess(),
          schedule: isWorkerProcess(),
        });
        boss.on('error', (err) => this.logger.error({ err }, 'queue error'));
        await boss.start();
        await boss.createQueue(SMS_SEND_QUEUE, { name: SMS_SEND_QUEUE, ...SMS_RETRY, retentionDays: 14 });
        this.boss = boss;
        return boss;
      })().catch((err) => {
        this.starting = null;
        throw err;
      });
    }
    return this.starting;
  }

  /**
   * Inserts the job inside the caller's transaction, so a message row and its job commit (or roll back) together.
   * Jobs are in PostgreSQL, so they survive API and worker restarts.
   */
  async sendSms(job: SmsSendJob, startAfter: Date | null, tx?: Tx): Promise<void> {
    const boss = await this.get();
    const opts: PgBoss.SendOptions = { ...SMS_RETRY };
    if (startAfter) opts.startAfter = startAfter;
    if (tx) {
      opts.db = { executeSql: async (text, values) => ({ rows: [...(await tx.executeQuery(CompiledQuery.raw(text, values))).rows] }) };
    }
    await boss.send(SMS_SEND_QUEUE, job, opts);
  }

  async onApplicationShutdown(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    this.starting = null;
    if (boss) await boss.stop({ graceful: true, wait: true, timeout: 10_000 });
  }
}
