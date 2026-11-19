// Owner: Agent H. Builds the GET /system/status report: backups, disk space, queue backlog, audit chain check, SMS provider, version.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFile, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { KYSELY, type Db } from '../../common/db/database.module';
import { APP_CONFIG, type AppConfig } from '../../common/config';

export type ComponentResult = 'success' | 'failure' | 'running' | 'waiting' | 'unknown';

export interface BackupComponentStatus {
  component: string;
  result: ComponentResult;
  updatedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  message: string;
  [extra: string]: unknown;
}

export interface DiskStatus {
  label: 'data' | 'backup';
  path: string;
  totalBytes: number;
  freeBytes: number;
  freePercent: number;
  low: boolean;
}

export interface SystemStatus {
  version: string;
  checkedAt: string;
  overall: 'ok' | 'warning' | 'problem';
  problems: string[];
  backup: {
    lastBackupAt: string | null;
    lastBackupResult: ComponentResult;
    backupOverdue: boolean;
    components: BackupComponentStatus[];
  };
  disks: DiskStatus[];
  queue: { available: boolean; pending: number | null; failed: number | null };
  auditChain: AuditChainSummary;
  smsProvider: string;
}

/**
 * Result of the worker's daily audit hash-chain check (CP5-04). The worker writes it to
 * <SMS_FILE_STORAGE_DIR>/audit-anchors/latest.json (modules/audit/audit-chain.job.ts).
 */
export interface AuditChainSummary {
  result: 'intact' | 'broken' | 'unknown';
  checkedAt: string | null;
  headId: number | null;
  count: number | null;
  overdue: boolean;
  problems: string[];
}

/** The daily audit chain check is reported overdue after this (daily + slack for a power cut). */
export const AUDIT_CHECK_OVERDUE_HOURS = 26;

/** Pure: parses the audit anchor file. A missing file (job never ran yet) is "unknown" and not a problem. */
export function parseAuditChain(raw: string | null, now: Date): AuditChainSummary {
  const unknown: AuditChainSummary = { result: 'unknown', checkedAt: null, headId: null, count: null, overdue: false, problems: [] };
  if (raw === null) return unknown;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const checkedAt = typeof j.checkedAt === 'string' && !Number.isNaN(Date.parse(j.checkedAt)) ? j.checkedAt : null;
    const result = j.result === 'intact' || j.result === 'broken' ? j.result : 'unknown';
    return {
      result,
      checkedAt,
      headId: typeof j.headId === 'number' ? j.headId : null,
      count: typeof j.count === 'number' ? j.count : null,
      overdue: !checkedAt || now.getTime() - Date.parse(checkedAt) > AUDIT_CHECK_OVERDUE_HOURS * 3_600_000,
      problems: Array.isArray(j.problems) ? j.problems.filter((p): p is string => typeof p === 'string').slice(0, 10) : [],
    };
  } catch {
    return { ...unknown, overdue: true, problems: ['The audit check result file could not be read'] };
  }
}

/** Full backup older than this is reported as overdue (nightly + slack for a power cut). */
export const BACKUP_OVERDUE_HOURS = 26;
/** Below this, a disk is reported low (matches the backup container's DISK_MIN_FREE_PERCENT default). */
export const DISK_LOW_PERCENT = 15;

const KNOWN_RESULTS: ComponentResult[] = ['success', 'failure', 'running', 'waiting'];

/** Pure: parses one backup status file written by infra/backup/bin/lib.sh. Unknown shapes become result "unknown". */
export function parseComponentStatus(name: string, raw: string): BackupComponentStatus {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const result = KNOWN_RESULTS.includes(j.result as ComponentResult) ? (j.result as ComponentResult) : 'unknown';
    const { component: _c, result: _r, updatedAt: _u, lastSuccessAt: _s, lastFailureAt: _f, message: _m, ...extra } = j;
    return {
      ...extra,
      component: str(j.component) ?? name,
      result,
      updatedAt: str(j.updatedAt),
      lastSuccessAt: str(j.lastSuccessAt),
      lastFailureAt: str(j.lastFailureAt),
      message: str(j.message) ?? '',
    };
  } catch {
    return { component: name, result: 'unknown', updatedAt: null, lastSuccessAt: null, lastFailureAt: null, message: 'Status file could not be read' };
  }
}

/** Pure: turns the collected facts into the overall verdict and plain-English problems for the admin dashboard. */
export function summarise(
  components: BackupComponentStatus[],
  disks: DiskStatus[],
  queue: SystemStatus['queue'],
  now: Date,
  auditChain?: AuditChainSummary,
): Pick<SystemStatus, 'overall' | 'problems' | 'backup'> {
  const problems: string[] = [];
  if (auditChain?.result === 'broken') {
    problems.push(`The daily audit trail check found possible tampering: ${auditChain.problems[0] ?? 'the hash chain is broken'}. Tell the headteacher and keep the backups.`);
  } else if (auditChain && auditChain.result !== 'unknown' && auditChain.overdue) {
    problems.push(`The daily audit trail check has not run for more than ${AUDIT_CHECK_OVERDUE_HOURS} hours (is the worker running?).`);
  } else if (auditChain && auditChain.result === 'unknown' && auditChain.problems.length > 0) {
    problems.push(auditChain.problems[0]!);
  }
  const base = components.find((c) => c.component === 'base-backup');
  const lastBackupAt = base?.lastSuccessAt ?? null;
  const overdue = !lastBackupAt || now.getTime() - Date.parse(lastBackupAt) > BACKUP_OVERDUE_HOURS * 3_600_000;
  if (!base) problems.push('No backup has been recorded yet.');
  else if (base.result === 'failure') problems.push(`The last backup failed: ${base.message}`);
  else if (overdue) problems.push(`The last good backup is more than ${BACKUP_OVERDUE_HOURS} hours old.`);
  for (const c of components) {
    if (c.component !== 'base-backup' && c.result === 'failure') problems.push(c.message || `${c.component} reported a problem.`);
  }
  for (const d of disks) if (d.low) problems.push(`Disk space is low on the ${d.label} disk (${d.freePercent}% free).`);
  if (queue.available && (queue.failed ?? 0) > 0) problems.push(`${queue.failed} background job(s) failed (for example SMS sending).`);
  const offsiteWaiting = components.some((c) => c.component === 'offsite' && c.result === 'waiting');
  const overall: SystemStatus['overall'] = problems.length > 0 ? 'problem' : offsiteWaiting || !queue.available ? 'warning' : 'ok';
  return { overall, problems, backup: { lastBackupAt, lastBackupResult: base?.result ?? 'unknown', backupOverdue: overdue, components } };
}

@Injectable()
export class SystemStatusService {
  private readonly logger = new Logger('SystemStatus');

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private get statusDir(): string {
    return process.env.SMS_BACKUP_STATUS_DIR ?? './var/backup-status';
  }

  async status(now = new Date()): Promise<SystemStatus> {
    const [components, disks, queue, auditChain] = await Promise.all([this.readBackupStatus(), this.readDisks(), this.queueBacklog(), this.readAuditChain(now)]);
    return {
      version: process.env.SMS_APP_VERSION ?? 'dev',
      checkedAt: now.toISOString(),
      ...summarise(components, disks, queue, now, auditChain),
      disks,
      queue,
      auditChain,
      smsProvider: this.cfg.SMS_SMS_PROVIDER,
    };
  }

  async readBackupStatus(): Promise<BackupComponentStatus[]> {
    let names: string[];
    try {
      names = (await readdir(this.statusDir)).filter((f) => f.endsWith('.json')).sort();
    } catch (err) {
      this.logger.warn({ err, dir: this.statusDir }, 'backup status folder not readable');
      return [];
    }
    return Promise.all(
      names.map(async (f) => {
        const name = f.replace(/\.json$/, '');
        try {
          return parseComponentStatus(name, await readFile(join(this.statusDir, f), 'utf8'));
        } catch (err) {
          this.logger.warn({ err, file: f }, 'backup status file not readable');
          return parseComponentStatus(name, '');
        }
      }),
    );
  }

  async readAuditChain(now: Date): Promise<AuditChainSummary> {
    let raw: string | null = null;
    try {
      raw = await readFile(join(this.cfg.SMS_FILE_STORAGE_DIR, 'audit-anchors', 'latest.json'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err }, 'audit chain status not readable');
        raw = '';
      }
    }
    return parseAuditChain(raw, now);
  }

  async readDisks(): Promise<DiskStatus[]> {
    const targets: Array<[DiskStatus['label'], string]> = [
      ['data', this.cfg.SMS_FILE_STORAGE_DIR],
      ['backup', this.statusDir],
    ];
    const out: DiskStatus[] = [];
    for (const [label, path] of targets) {
      try {
        const s = await statfs(path);
        const totalBytes = s.blocks * s.bsize;
        const freeBytes = s.bavail * s.bsize;
        const freePercent = totalBytes > 0 ? Math.floor((freeBytes * 100) / totalBytes) : 0;
        out.push({ label, path, totalBytes, freeBytes, freePercent, low: freePercent < DISK_LOW_PERCENT });
      } catch (err) {
        this.logger.warn({ err, path }, 'disk usage not available');
      }
    }
    return out;
  }

  async queueBacklog(): Promise<SystemStatus['queue']> {
    try {
      const r = await sql<{ pending: number; failed: number }>`
        SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS pending,
               count(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '7 days')::int AS failed
        FROM pgboss.job`.execute(this.db);
      const row = r.rows[0];
      return { available: true, pending: row?.pending ?? 0, failed: row?.failed ?? 0 };
    } catch (err) {
      // pgboss schema not created yet (worker never started) or no permission: report, do not fail the page.
      this.logger.warn({ err }, 'queue backlog not available');
      return { available: false, pending: null, failed: null };
    }
  }
}
