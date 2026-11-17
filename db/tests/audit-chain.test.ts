import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './support';

let db: TestDb;

beforeAll(async () => {
  db = await createDb();
});
afterAll(async () => db?.drop());

describe('audit hash chain', () => {
  it('links concurrent inserts into one linear chain and verify_chain reports it intact', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 10 });
    try {
      await Promise.all(Array.from({ length: 40 }, async (_, i) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(
            `INSERT INTO audit.events (action, entity_type, entity_id, changes, ip) VALUES ('update', 'student', $1, $2, '10.0.0.1')`,
            [String(i), JSON.stringify({ after: { n: i } })],
          );
          if (i % 7 === 3) await c.query('ROLLBACK');
          else await c.query('COMMIT');
        } finally {
          c.release();
        }
      }));
      const rows = (await pool.query('SELECT id, prev_hash, hash FROM audit.events ORDER BY id')).rows;
      expect(rows.length).toBe(40 - 6);
      expect(rows[0].prev_hash).toBeNull();
      for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
      for (const r of rows) expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await pool.query('SELECT * FROM audit.verify_chain()')).rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('hash is SHA-256 over the documented canonical form', async () => {
    const c = await db.client();
    const r = (await c.query(
      `INSERT INTO audit.events (action, entity_type, entity_id, occurred_at) VALUES ('view', 'student', 'abc', '2026-11-17T08:00:00Z') RETURNING *`,
    )).rows[0];
    const canonical = [r.prev_hash ?? '', String(r.id), '2026-11-17T08:00:00.000000Z', '', '', '', '', 'view', 'student', 'abc', '', '', '', ''].join('|');
    expect(r.hash).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
  });

  it('verify_chain detects tampering (simulated by a superuser bypassing the trigger)', async () => {
    const c = await db.client();
    await c.query('BEGIN');
    await c.query('ALTER TABLE audit.events DISABLE TRIGGER events_append_only');
    const { id } = (await c.query('SELECT id FROM audit.events ORDER BY id OFFSET 2 LIMIT 1')).rows[0];
    await c.query(`UPDATE audit.events SET entity_id = 'tampered' WHERE id = $1`, [id]);
    const problems = (await c.query('SELECT * FROM audit.verify_chain()')).rows;
    await c.query('ROLLBACK');
    expect(problems.map((p) => Number(p.id))).toContain(Number(id));
  });
});
