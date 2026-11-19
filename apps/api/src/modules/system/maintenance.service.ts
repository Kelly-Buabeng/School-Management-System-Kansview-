// Owner: Agent H. Housekeeping that runs in the worker process only (SMS_PROCESS_ROLE=worker), once an hour:
//  - expired / revoked sessions older than SESSION_KEEP_DAYS
//  - used or expired password-reset tokens older than RESET_TOKEN_KEEP_DAYS
//  - login attempts older than LOGIN_ATTEMPT_KEEP_DAYS, through app.purge_login_attempts(interval) when the database
//    provides it (CR-0009): the app role has no DELETE on that append-only table.
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Db } from '../../common/db/database.module';

export const SESSION_KEEP_DAYS = 30;
export const RESET_TOKEN_KEEP_DAYS = 7;
export const LOGIN_ATTEMPT_KEEP_DAYS = 180;
const INTERVAL_MS = 60 * 60 * 1000;

export interface MaintenanceResult {
  sessionsDeleted: number;
  resetTokensDeleted: number;
  loginAttemptsDeleted: number | null; // null = purge function not installed
}

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Maintenance');
  private timer: NodeJS.Timeout | null = null;
  private warnedNoPurge = false;

  constructor(@Inject(KYSELY) private readonly db: Db) {}

  onApplicationBootstrap(): void {
    if (process.env.SMS_PROCESS_ROLE !== 'worker') return;
    const tick = () => {
      this.runOnce().catch((err) => this.logger.error({ err }, 'housekeeping run failed; will retry next hour'));
    };
    setTimeout(tick, 60_000).unref();
    this.timer = setInterval(tick, INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<MaintenanceResult> {
    const sessions = await sql`
      DELETE FROM app.user_sessions
      WHERE greatest(expires_at, idle_expires_at, coalesce(revoked_at, '-infinity')) < now() - make_interval(days => ${SESSION_KEEP_DAYS})`.execute(this.db);
    const tokens = await sql`
      DELETE FROM app.password_reset_tokens
      WHERE greatest(expires_at, coalesce(used_at, '-infinity')) < now() - make_interval(days => ${RESET_TOKEN_KEEP_DAYS})`.execute(this.db);

    let loginAttemptsDeleted: number | null = null;
    const hasPurge = await sql<{ ok: boolean }>`SELECT to_regprocedure('app.purge_login_attempts(interval)') IS NOT NULL AS ok`.execute(this.db);
    if (hasPurge.rows[0]?.ok) {
      const r = await sql<{ n: number }>`SELECT app.purge_login_attempts(make_interval(days => ${LOGIN_ATTEMPT_KEEP_DAYS}))::int AS n`.execute(this.db);
      loginAttemptsDeleted = r.rows[0]?.n ?? 0;
    } else if (!this.warnedNoPurge) {
      this.warnedNoPurge = true;
      this.logger.warn('app.purge_login_attempts(interval) is not installed (CR-0009); old login attempts are kept');
    }

    const result: MaintenanceResult = {
      sessionsDeleted: Number(sessions.numAffectedRows ?? 0n),
      resetTokensDeleted: Number(tokens.numAffectedRows ?? 0n),
      loginAttemptsDeleted,
    };
    this.logger.log({ ...result }, 'housekeeping done');
    return result;
  }
}
