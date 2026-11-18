// Owner: Agent F. Minimal fake records for Agent F integration tests. Fake Ghanaian data, test phone numbers only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AuthUser } from '../../src/security/auth-user';
import { fakeUser } from '../support/test-app';
import type { Role } from '../../src/security/permissions';

export class Seed {
  private seq = 0;
  constructor(readonly client: pg.Client) {}

  static async connect(url: string): Promise<Seed> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return new Seed(c);
  }
  async end(): Promise<void> {
    await this.client.end();
  }
  async q<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(text, params)).rows;
  }

  /** Inserts a users row (needed for requested_by / approved_by foreign keys) and returns a matching AuthUser. */
  async user(roles: Role[], overrides: Partial<AuthUser> = {}): Promise<AuthUser> {
    const id = overrides.id ?? randomUUID();
    const username = `f-${roles.join('-').toLowerCase()}-${++this.seq}-${id.slice(0, 6)}`;
    await this.q(
      `INSERT INTO users (id, username, full_name, password_hash, roles) VALUES ($1, $2, $3, 'x', $4) ON CONFLICT (id) DO NOTHING`,
      [id, username, `Test ${roles.join(' ')}`, roles],
    );
    return fakeUser(roles, { id, username, ...overrides });
  }

  async student(firstName = 'Ama', lastName = 'Mensah', classId: string | null = null): Promise<string> {
    const [r] = await this.q<{ id: string }>(
      `WITH c AS (SELECT app.next_student_code(2026) AS code)
       INSERT INTO students (student_code, admission_year, admission_seq, first_name, last_name, date_of_birth, gender, admission_class_id)
       SELECT code, 2026, substr(code, 8, 5)::int, $1, $2, '2017-03-04', 'female', $3 FROM c RETURNING id`,
      [firstName, lastName, classId],
    );
    return r!.id;
  }

  async guardian(phone: string, firstName = 'Kwame', lastName = 'Mensah'): Promise<string> {
    const [r] = await this.q<{ id: string }>(
      `INSERT INTO guardians (first_name, last_name, phone_primary) VALUES ($1, $2, $3) RETURNING id`, [firstName, lastName, phone],
    );
    return r!.id;
  }

  async link(studentId: string, guardianId: string, opts: { primary?: boolean; receivesSms?: boolean } = {}): Promise<void> {
    await this.q(
      `INSERT INTO student_guardians (student_id, guardian_id, relationship, is_primary, receives_sms) VALUES ($1, $2, 'father', $3, $4)`,
      [studentId, guardianId, opts.primary ?? true, opts.receivesSms ?? true],
    );
  }

  async file(storageKey: string, opts: { scan?: string; name?: string; mime?: string; size?: number; uploadedBy?: string | null } = {}): Promise<string> {
    const [r] = await this.q<{ id: string }>(
      `INSERT INTO files (storage_key, original_name, mime_type, size_bytes, sha256, scan_status, uploaded_by)
       VALUES ($1, $2, $3, $4, 'x', $5, $6) RETURNING id`,
      [storageKey, opts.name ?? 'birth-cert.pdf', opts.mime ?? 'application/pdf', opts.size ?? 0, opts.scan ?? 'clean', opts.uploadedBy ?? null],
    );
    return r!.id;
  }
}
