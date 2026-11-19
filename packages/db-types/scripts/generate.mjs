// Regenerates src/db.ts from the migrations.
// Creates a throw-away database (a_types_<random>), applies db/migrations, runs kysely-codegen against it,
// post-processes the output, then drops the database.
// Usage: pnpm --filter @sms/db-types generate   (admin URL from SMS_TEST_DB_ADMIN_URL, default local dev server)
// Set SMS_DB_URL to generate against an existing, already-migrated database instead.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../../db/tools/migrate.mjs';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(pkgDir, 'src', 'db.ts');
const adminUrl = process.env.SMS_TEST_DB_ADMIN_URL ?? 'postgres://sms:sms@localhost:5432/postgres';

async function withDatabase(fn) {
  if (process.env.SMS_DB_URL) return fn(process.env.SMS_DB_URL);
  const name = `a_types_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  try {
    const url = adminUrl.replace(/\/[^/]*$/, `/${name}`);
    await migrate(url, { log: () => {} });
    return await fn(url);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

// Materialised views: kysely-codegen < 0.20 skips them and >= 0.20 types every column as nullable.
// Describe them precisely here (keep in sync with 0005) and replace whatever the generator emitted.
const MATVIEWS = `
export interface MvStudentBalances {
  balance_pesewas: Int8;
  last_payment_at: Timestamp | null;
  oldest_unpaid_term_id: string | null;
  refreshed_at: Timestamp;
  student_id: string;
}
`;

await withDatabase(async (url) => {
  execFileSync(
    join(pkgDir, 'node_modules', '.bin', 'kysely-codegen'),
    ['--dialect', 'postgres', '--url', url, '--default-schema', 'app', '--include-pattern', '{app,audit,import}.*',
      '--date-parser', 'string', '--log-level', 'error', '--out-file', outFile],
    { stdio: 'inherit' },
  );
});

let src = readFileSync(outFile, 'utf8');
// apps/api parses int8 to a JS number (common/db/database.module.ts), so type it as number.
src = src.replace(
  /export type Int8 = ColumnType<[^;]+;/,
  'export type Int8 = ColumnType<number, bigint | number | string, bigint | number | string>;',
);
src = src.replace(/\nexport interface MvStudentBalances \{[^}]*\}\n/, '\n');
src = src.replace(/\nexport interface DB \{/, `${MATVIEWS}\nexport interface DB {`);
if (!/ {2}mv_student_balances: MvStudentBalances;/.test(src)) {
  src = src.replace(/( {2}messages: Messages;\n)/, '$1  mv_student_balances: MvStudentBalances;\n');
}
if (!src.includes('mv_student_balances: MvStudentBalances')) throw new Error('post-processing failed: DB interface changed shape');
writeFileSync(outFile, src);
console.log(`wrote ${outFile}`);
