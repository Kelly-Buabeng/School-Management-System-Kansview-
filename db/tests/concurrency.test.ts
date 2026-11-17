import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidStudentCode } from '../../packages/shared/src/damm';
import { createDb, one, type TestDb } from './support';

let db: TestDb;

beforeAll(async () => {
  db = await createDb();
});
afterAll(async () => db?.drop());

describe('counters under concurrency', () => {
  it('50 concurrent next_student_code calls on separate connections give 50 unique, Damm-valid codes', async () => {
    const clients = await Promise.all(Array.from({ length: 50 }, () => db.client()));
    try {
      const codes = await Promise.all(clients.map(async (c) => (await one<{ code: string }>(c, 'SELECT app.next_student_code(2026) AS code')).code));
      expect(new Set(codes).size).toBe(50);
      for (const code of codes) expect(isValidStudentCode(code)).toBe(true);
      const seqs = codes.map((x) => Number(x.split('-')[2])).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('200 concurrent next_doc_no calls with random rollbacks leave no gaps among committed numbers', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 20 });
    const committed: number[] = [];
    let rolledBack = 0;
    try {
      await Promise.all(Array.from({ length: 200 }, async (_, i) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const { n } = (await c.query(`SELECT app.next_doc_no('receipt') AS n`)).rows[0] as { n: string };
          await c.query(`SELECT pg_sleep(${(i % 5) / 1000})`);
          if (i % 4 === 1) {
            await c.query('ROLLBACK');
            rolledBack++;
          } else {
            await c.query('COMMIT');
            committed.push(Number(n.replace('RCP-', '')));
          }
        } finally {
          c.release();
        }
      }));
      expect(rolledBack).toBe(50);
      const sorted = [...committed].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
      const { last_value } = (await pool.query(`SELECT last_value FROM app.doc_counters WHERE doc_type = 'receipt'`)).rows[0];
      expect(Number(last_value)).toBe(150);
    } finally {
      await pool.end();
    }
  });
});
