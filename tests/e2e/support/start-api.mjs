// Owner: Agent H. Playwright webServer #1: fresh database (migrated + fake seed) and the real API on E2E_API_PORT.
// The database is dropped and recreated on every run, so tests start from the same known state.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const requireFromDb = createRequire(join(root, 'db/package.json'));
const pg = requireFromDb('pg');
const { migrate } = await import(join(root, 'db/tools/migrate.mjs'));
const { seed } = await import(join(root, 'db/seeds/seed.mjs'));

const ADMIN_URL = process.env.SMS_TEST_DB_ADMIN_URL ?? 'postgres://sms:sms@localhost:5432/postgres';
const DB_NAME = process.env.E2E_DB_NAME ?? 'h_e2e';
const PORT = process.env.E2E_API_PORT ?? '3100';
if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) throw new Error(`unsafe E2E_DB_NAME ${DB_NAME}`);

const tmp = join(root, 'tests/e2e/.tmp');
mkdirSync(join(tmp, 'storage'), { recursive: true });
const keyFile = join(tmp, 'master.key');
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, `1:${randomBytes(32).toString('base64')}\nbidx:${randomBytes(32).toString('base64')}\n`);
  chmodSync(keyFile, 0o600);
}

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB_NAME}`);
await admin.end();
const dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
const t0 = Date.now();
await migrate(dbUrl, { log: () => {} });
await seed(dbUrl, { masterKeyFile: keyFile, skipMigrate: true, log: () => {} });
console.log(`[e2e] database ${DB_NAME} migrated and seeded in ${Date.now() - t0} ms`);
writeFileSync(join(tmp, 'db-url'), dbUrl);

const main = join(root, 'apps/api/dist/main.js');
if (!existsSync(main)) throw new Error('apps/api/dist/main.js missing: run `pnpm --filter @sms/api build` first');
const child = spawn(process.execPath, [main], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SMS_NODE_ENV: 'development',
    SMS_PORT: PORT,
    SMS_DB_URL: dbUrl,
    SMS_MASTER_KEY_FILE: keyFile,
    SMS_FILE_STORAGE_DIR: join(tmp, 'storage'),
    SMS_BACKUP_STATUS_DIR: tmp,
    SMS_CLAMAV_ENABLED: 'false',
    SMS_SMS_PROVIDER: 'mock',
    SMS_LOG_LEVEL: process.env.SMS_LOG_LEVEL ?? 'warn',
  },
});
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
