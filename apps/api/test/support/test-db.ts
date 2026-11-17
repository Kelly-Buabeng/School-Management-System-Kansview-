// Owner: Orchestrator. Creates an isolated, fully migrated database per test file so agents can run integration tests in parallel.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain ESM JS module owned by Agent A
import { migrate } from '../../../../db/tools/migrate.mjs';

const ADMIN_URL = process.env.SMS_TEST_DB_ADMIN_URL ?? 'postgres://sms:sms@localhost:5432/postgres';

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(prefix = 'sms_t'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  await migrate(url, { log: () => {} });
  return {
    url,
    name,
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
