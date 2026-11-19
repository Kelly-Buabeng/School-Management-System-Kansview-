// CP5-04: the daily audit chain check is scheduled in the worker and its external anchor detects deleted tail events.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { bootRealApp } from './support';
import { AUDIT_SERVICE, type AuditService } from '../../src/security/audit.service';
import { AuditQueryService } from '../../src/modules/audit/audit.service';
import { AUDIT_CHAIN_CRON, AUDIT_CHAIN_QUEUE, AUDIT_CHAIN_TZ, AuditChainJob } from '../../src/modules/audit/audit-chain.job';

let tdb: TestDatabase;
let ctx: Awaited<ReturnType<typeof bootRealApp>>;
let storage: string;

beforeAll(async () => {
  storage = mkdtempSync(join(tmpdir(), 'd-anchor-'));
  process.env.SMS_FILE_STORAGE_DIR = storage;
  tdb = await createTestDatabase('d_chainjob');
  ctx = await bootRealApp(tdb.url);
});
afterAll(async () => {
  await ctx?.close();
  await tdb?.drop();
});

const record = async (n: number, entityType: string) => {
  const audit = ctx.app.get<AuditService>(AUDIT_SERVICE);
  for (let i = 0; i < n; i++) await audit.record({ action: 'update', entityType, reason: `probe ${i}` }, null);
};

describe('daily audit chain job (CP5-04)', () => {
  it('writes an anchor of the chain head outside the database', async () => {
    await record(5, 'payment');
    const job = ctx.app.get(AuditChainJob);
    const r = await job.runOnce();
    expect(r.result).toBe('intact');
    const head = await ctx.db.selectFrom('audit.events').select(['id', 'hash']).orderBy('id', 'desc').limit(1).executeTakeFirstOrThrow();
    const latest = JSON.parse(readFileSync(join(storage, 'audit-anchors', 'latest.json'), 'utf8'));
    expect(latest).toMatchObject({ result: 'intact', headId: Number(head.id), headHash: head.hash, reference: { headId: Number(head.id) } });
    expect(readFileSync(join(storage, 'audit-anchors', 'anchors.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('detects deleted tail events that the in-database verification cannot see, and stays broken', async () => {
    const job = ctx.app.get(AuditChainJob);
    await record(3, 'payment_reversal');
    expect((await job.runOnce()).result).toBe('intact');
    const anchored = (await job.readStatus())!.headId!;

    // A superuser removes the newest events (for example the reversal and its export) and re-enables the trigger.
    await record(2, 'export');
    await sql`ALTER TABLE audit.events DISABLE TRIGGER events_append_only`.execute(ctx.db);
    await sql`DELETE FROM audit.events WHERE id >= ${anchored - 1}`.execute(ctx.db);
    await sql`ALTER TABLE audit.events ENABLE TRIGGER events_append_only`.execute(ctx.db);

    // The links between the rows that are left are still valid, so the plain verification says intact.
    expect((await ctx.app.get(AuditQueryService).verify()).intact).toBe(true);

    const r = await job.runOnce();
    expect(r.result).toBe('broken');
    expect(r.problems.join('\n')).toMatch(new RegExp(`event #${anchored}.*is missing`));
    expect(r.reference?.headId).toBe(anchored);

    // New events do not hide it: the reference is not moved forward while the chain is broken.
    await record(4, 'payment');
    const again = await job.runOnce();
    expect(again.result).toBe('broken');
    expect(again.reference?.headId).toBe(anchored);
  });

  it('registers a daily pg-boss schedule in the worker', async () => {
    const job = ctx.app.get(AuditChainJob);
    await job.start();
    const rows = await sql<{ name: string; cron: string; options: { tz?: string } }>`SELECT name, cron, options FROM pgboss.schedule WHERE name = ${AUDIT_CHAIN_QUEUE}`.execute(ctx.db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ cron: AUDIT_CHAIN_CRON, options: { tz: AUDIT_CHAIN_TZ } });
  });
});
