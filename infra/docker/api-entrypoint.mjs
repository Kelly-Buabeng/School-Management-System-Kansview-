// Owner: Agent H. Container entrypoint for the api image.
// Builds SMS_DB_URL from Docker secret files so no password ever appears in an environment variable literal,
// then starts the requested process. Usage: node docker-entrypoint.mjs <api|worker|migrate|healthcheck|db-check>
import { readFileSync } from 'node:fs';

function readSecret(path, label) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!value) throw new Error('file is empty');
    return value;
  } catch (err) {
    console.error(JSON.stringify({ level: 'fatal', msg: `cannot read secret ${label} from ${path}: ${err.message}` }));
    process.exit(1);
  }
}

function buildDbUrl() {
  if (process.env.SMS_DB_URL) return process.env.SMS_DB_URL; // dev / CI only
  const pwFile = process.env.SMS_DB_PASSWORD_FILE;
  if (!pwFile) {
    console.error(JSON.stringify({ level: 'fatal', msg: 'Set SMS_DB_PASSWORD_FILE (production) or SMS_DB_URL (development)' }));
    process.exit(1);
  }
  const user = encodeURIComponent(process.env.SMS_DB_USER ?? 'sms_app');
  const password = encodeURIComponent(readSecret(pwFile, 'SMS_DB_PASSWORD_FILE'));
  const host = process.env.SMS_DB_HOST ?? 'postgres';
  const port = process.env.SMS_DB_PORT ?? '5432';
  const name = encodeURIComponent(process.env.SMS_DB_NAME ?? 'sms');
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

const cmd = process.argv[2] ?? 'api';

switch (cmd) {
  case 'api':
    process.env.SMS_DB_URL = buildDbUrl();
    await import('./dist/main.js');
    break;
  case 'worker':
    process.env.SMS_DB_URL = buildDbUrl();
    await import('./dist/worker.js');
    break;
  case 'migrate': {
    const url = buildDbUrl();
    const { migrate } = await import('./db/tools/migrate.mjs');
    try {
      await migrate(url, { log: (m) => console.log(JSON.stringify({ level: 'info', msg: m })) });
      console.log(JSON.stringify({ level: 'info', msg: 'migrations up to date' }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'fatal', msg: 'migration failed', err: err.message }));
      process.exit(1);
    }
    break;
  }
  case 'healthcheck': {
    // Used by the Dockerfile HEALTHCHECK for the api process.
    const port = process.env.SMS_PORT ?? '3000';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`, { signal: AbortSignal.timeout(4000) });
      process.exit(res.ok ? 0 : 1);
    } catch {
      process.exit(1);
    }
    break;
  }
  case 'db-check': {
    // Worker healthcheck: the worker has no HTTP port, so check that it can reach the database it works from.
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: buildDbUrl(), connectionTimeoutMillis: 4000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      process.exit(0);
    } catch {
      process.exit(1);
    }
    break;
  }
  default:
    console.error(`unknown command "${cmd}" (expected api, worker, migrate, healthcheck or db-check)`);
    process.exit(2);
}
