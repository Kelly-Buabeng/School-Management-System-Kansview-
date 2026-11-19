// Owner: Agent D. Daily audit hash-chain check with an external anchor of the chain head (CP5-04, threat model 4.5/7/8).
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import { KYSELY, type Db } from '../../common/db/database.module';
import { BossService, isWorkerProcess } from '../notifications/queue/boss.service';
import { AuditQueryService } from './audit.service';

export const AUDIT_CHAIN_QUEUE = 'audit-verify-chain';
/** Every day at 03:47 Africa/Accra: after the 01:30 nightly backup, outside school hours. */
export const AUDIT_CHAIN_CRON = '47 3 * * *';
export const AUDIT_CHAIN_TZ = 'Africa/Accra';

/** The chain head as seen at one check. */
export interface ChainHead {
  headId: number | null;
  headHash: string | null;
  count: number;
  checkedAt: string;
}

/**
 * Written to `<SMS_FILE_STORAGE_DIR>/audit-anchors/latest.json` after every check (history in anchors.jsonl).
 * The file lives outside PostgreSQL on purpose: someone who can disable the audit triggers and delete the newest
 * events cannot also rewrite this anchor, so deleting the tail of the chain is detected at the next check.
 */
export interface AuditChainStatus extends ChainHead {
  result: 'intact' | 'broken';
  problems: string[];
  /** The last head that was checked intact. Not moved forward while the chain is broken. */
  reference: ChainHead | null;
}

export const anchorDir = (cfg: Pick<AppConfig, 'SMS_FILE_STORAGE_DIR'>): string => join(cfg.SMS_FILE_STORAGE_DIR, 'audit-anchors');

@Injectable()
export class AuditChainJob implements OnApplicationBootstrap {
  private readonly logger = new Logger('AuditChain');

  constructor(
    private readonly audit: AuditQueryService,
    @Inject(KYSELY) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    if (!isWorkerProcess()) return;
    this.start().catch((err) => this.logger.error({ err }, 'could not schedule the daily audit chain check'));
  }

  /** Registers the daily schedule and the handler in pg-boss (worker only; public for tests). */
  async start(): Promise<void> {
    const boss = await this.moduleRef.get(BossService, { strict: false }).get();
    await boss.createQueue(AUDIT_CHAIN_QUEUE, { name: AUDIT_CHAIN_QUEUE, retryLimit: 1, retryDelay: 600, retentionDays: 30 });
    await boss.schedule(AUDIT_CHAIN_QUEUE, AUDIT_CHAIN_CRON, {}, { tz: AUDIT_CHAIN_TZ });
    await boss.work(AUDIT_CHAIN_QUEUE, { batchSize: 1 }, async () => {
      const r = await this.runOnce();
      // A failed job also shows on /system/status ("failed jobs"), so a broken chain reaches the admin dashboard.
      if (r.result === 'broken') throw new Error(`audit chain broken: ${r.problems.join('; ')}`);
      return { headId: r.headId, count: r.count };
    });
    this.logger.log({ cron: AUDIT_CHAIN_CRON, tz: AUDIT_CHAIN_TZ }, 'daily audit chain check scheduled');
  }

  /** One check: recompute the chain, compare the head with the last intact anchor, write the new anchor, alert. */
  async runOnce(): Promise<AuditChainStatus> {
    const verification = await this.audit.verify();
    const head = await this.db.selectFrom('audit.events').select(['id', 'hash']).orderBy('id', 'desc').limit(1).executeTakeFirst();
    const total = await this.db.selectFrom('audit.events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const now: ChainHead = { headId: head ? Number(head.id) : null, headHash: head?.hash ?? null, count: Number(total.n), checkedAt: new Date().toISOString() };

    const previous = await this.readStatus();
    const reference = previous?.reference ?? null;
    const problems = verification.problems.map((p) => `event #${p.id}: ${p.problem}`);
    if (reference?.headId != null) {
      const anchored = await this.db.selectFrom('audit.events').select('hash').where('id', '=', reference.headId).executeTakeFirst();
      if (!anchored) problems.push(`event #${reference.headId}, the newest event at the check on ${reference.checkedAt}, is missing: recent audit events were deleted`);
      else if (anchored.hash !== reference.headHash) problems.push(`event #${reference.headId} no longer has the hash recorded on ${reference.checkedAt}: it was changed`);
      if (now.count < reference.count) problems.push(`there are fewer audit events (${now.count}) than at the check on ${reference.checkedAt} (${reference.count})`);
      if (now.headId === null || now.headId < reference.headId) problems.push(`the newest audit event id went backwards (${now.headId ?? 'none'} < ${reference.headId})`);
    }
    const result = problems.length === 0 ? 'intact' : 'broken';
    const status: AuditChainStatus = { ...now, result, problems: problems.slice(0, 50), reference: result === 'intact' ? now : reference };
    await this.writeStatus(status);

    if (result === 'intact') this.logger.log({ headId: now.headId, headHash: now.headHash, count: now.count }, 'audit chain intact; daily anchor written');
    else this.logger.error({ headId: now.headId, problems: status.problems }, 'AUDIT CHAIN BROKEN: possible tampering');
    await this.push(status);
    return status;
  }

  async readStatus(): Promise<AuditChainStatus | null> {
    try {
      return JSON.parse(await readFile(join(anchorDir(this.cfg), 'latest.json'), 'utf8')) as AuditChainStatus;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err; // an unreadable anchor must not silently restart the chain of trust
    }
  }

  private async writeStatus(s: AuditChainStatus): Promise<void> {
    const dir = anchorDir(this.cfg);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await appendFile(join(dir, 'anchors.jsonl'), `${JSON.stringify(s)}\n`, { mode: 0o640 });
    const tmp = join(dir, `.latest.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o640 });
    await rename(tmp, join(dir, 'latest.json'));
  }

  /** Optional Uptime Kuma push monitor (SMS_AUDIT_PUSH_URL_FILE): "up" when intact, "down" when broken. */
  private async push(s: AuditChainStatus): Promise<void> {
    const file = process.env.SMS_AUDIT_PUSH_URL_FILE;
    if (!file) return;
    try {
      const base = (await readFile(file, 'utf8')).trim();
      if (!/^https?:\/\//.test(base)) return;
      const url = new URL(base);
      url.searchParams.set('status', s.result === 'intact' ? 'up' : 'down');
      url.searchParams.set('msg', s.result === 'intact' ? `audit chain intact, ${s.count} events` : 'AUDIT CHAIN BROKEN');
      await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'audit chain push to monitoring failed');
    }
  }
}
