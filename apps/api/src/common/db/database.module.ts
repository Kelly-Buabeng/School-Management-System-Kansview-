import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from '@sms/db-types';
import { APP_CONFIG, type AppConfig } from '../config';

// bigint (int8) → JS number. Safe: pesewas totals stay far below 2^53. Values above Number.MAX_SAFE_INTEGER throw.
types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${v} exceeds safe integer range`);
  return n;
});
// date → keep as 'YYYY-MM-DD' string (no timezone shifting)
types.setTypeParser(1082, (v) => v);

export const KYSELY = Symbol('KYSELY');
export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) =>
        new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: cfg.SMS_DB_URL, max: 20, application_name: 'sms-api' }) }) }),
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Db) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
