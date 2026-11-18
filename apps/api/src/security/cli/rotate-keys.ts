/**
 * Field-encryption key management CLI (owner: Agent D). Usage (inside the api container):
 *
 *   node dist/security/cli/rotate-keys.js generate [--bidx]
 *       Prints a new key line to APPEND to the master key file (next free id, or a blind-index key).
 *
 *   SMS_DB_URL=... SMS_MASTER_KEY_FILE=... node dist/security/cli/rotate-keys.js rotate [--dry-run]
 *       Re-wraps every encrypted value (all `*_enc bytea` columns in schema app) under the newest key.
 *       Only the 32-byte data key is re-encrypted; the payload is untouched. Safe to re-run; resumable.
 *
 *   ... rotate --check
 *       Counts values per key id (use before retiring an old key: it must show 0 for that id).
 *
 * See docs/security/key-management.md for the full procedure.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { FieldCryptoEngine, generateKeyLine, parseKeyFile } from '../field-crypto.service';

interface EncColumn {
  table: string;
  column: string;
  pk: string;
}

export async function discoverEncryptedColumns(client: pg.ClientBase): Promise<EncColumn[]> {
  const r = await client.query<{ table_name: string; column_name: string; pk: string }>(`
    SELECT c.table_name, c.column_name,
           (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = format('app.%I', c.table_name)::regclass AND i.indisprimary LIMIT 1) AS pk
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'app' AND c.data_type = 'bytea' AND c.column_name LIKE '%\\_enc'
     ORDER BY 1, 2`);
  return r.rows.map((x) => ({ table: x.table_name, column: x.column_name, pk: x.pk }));
}

/** Returns { column → { keyId → count } }. */
export async function keyUsage(client: pg.ClientBase): Promise<Record<string, Record<number, number>>> {
  const out: Record<string, Record<number, number>> = {};
  for (const c of await discoverEncryptedColumns(client)) {
    const r = await client.query<{ k: number; n: string }>(`SELECT get_byte(${c.column}, 1) AS k, count(*) AS n FROM app.${c.table} WHERE ${c.column} IS NOT NULL GROUP BY 1`);
    out[`${c.table}.${c.column}`] = Object.fromEntries(r.rows.map((x) => [x.k, Number(x.n)]));
  }
  return out;
}

export async function rotateAll(client: pg.ClientBase, engine: FieldCryptoEngine, opts: { dryRun?: boolean; batch?: number; log?: (m: string) => void } = {}): Promise<number> {
  const log = opts.log ?? (() => {});
  const batch = opts.batch ?? 500;
  let total = 0;
  for (const c of await discoverEncryptedColumns(client)) {
    for (;;) {
      const rows = await client.query<{ pk: string; v: Buffer }>(
        `SELECT ${c.pk}::text AS pk, ${c.column} AS v FROM app.${c.table} WHERE ${c.column} IS NOT NULL AND get_byte(${c.column}, 1) <> $1 LIMIT $2`,
        [engine.activeKeyId, batch],
      );
      if (rows.rows.length === 0) break;
      if (opts.dryRun) {
        total += rows.rows.length;
        break;
      }
      await client.query('BEGIN');
      try {
        for (const row of rows.rows) {
          await client.query(`UPDATE app.${c.table} SET ${c.column} = $1 WHERE ${c.pk}::text = $2`, [engine.rewrap(row.v), row.pk]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      total += rows.rows.length;
    }
    log(`${c.table}.${c.column}: done`);
  }
  return total;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...flags] = argv;
  if (cmd === 'generate') {
    if (flags.includes('--bidx')) {
      console.log(generateKeyLine('bidx'));
      return;
    }
    const file = process.env.SMS_MASTER_KEY_FILE;
    const next = file ? Math.max(...parseKeyFile(readFileSync(file, 'utf8')).keys.keys()) + 1 : 1;
    if (next > 255) throw new Error('No key ids left (255 max)');
    console.log(generateKeyLine(next));
    return;
  }
  if (cmd !== 'rotate') {
    console.error('Usage: rotate-keys generate [--bidx] | rotate [--dry-run|--check]');
    process.exitCode = 2;
    return;
  }
  const file = process.env.SMS_MASTER_KEY_FILE;
  if (!file || !process.env.SMS_DB_URL) throw new Error('SMS_MASTER_KEY_FILE and SMS_DB_URL are required');
  const engine = new FieldCryptoEngine(parseKeyFile(readFileSync(file, 'utf8')));
  const client = new pg.Client({ connectionString: process.env.SMS_DB_URL, application_name: 'sms-rotate-keys' });
  await client.connect();
  try {
    if (flags.includes('--check')) {
      console.log(JSON.stringify({ activeKeyId: engine.activeKeyId, usage: await keyUsage(client) }, null, 2));
      return;
    }
    const n = await rotateAll(client, engine, { dryRun: flags.includes('--dry-run'), log: (m) => console.log(m) });
    console.log(`${flags.includes('--dry-run') ? 'Would re-wrap at least' : 'Re-wrapped'} ${n} value(s) to key ${engine.activeKeyId}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
