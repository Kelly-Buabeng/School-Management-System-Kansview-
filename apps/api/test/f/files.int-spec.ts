import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILE_STORE, type FileStore } from '../../src/common/contracts';
import { generateStorageKey } from '../../src/modules/files/local-file-store';
import { AUDIT_SERVICE, SCOPE_SERVICE, type AuthUser } from '../../src/security';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createFTestApp, type FTestApp } from './app';
import { Seed } from './seed';

describe('GET /files/{id}', () => {
  let db: TestDatabase;
  let t: FTestApp;
  let seed: Seed;
  let dir: string;
  let store: FileStore;
  const hiddenStudents = new Set<string>();
  const audit: Array<{ action: string; entityId?: string | null }> = [];
  let registrar: AuthUser;
  let teacher: AuthUser;
  let bursar: AuthUser;
  let docFileId: string;
  let pendingFileId: string;
  let infectedFileId: string;
  let hiddenFileId: string;
  let logoFileId: string;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    db = await createTestDatabase('f_files');
    dir = await mkdtemp(join(tmpdir(), 'f-files-'));
    t = await createFTestApp(db.url, [
      { token: SCOPE_SERVICE, value: { allowedClassIds: async () => null, canAccessStudent: async (_u: unknown, id: string) => !hiddenStudents.has(id) } },
      { token: AUDIT_SERVICE, value: { record: async (e: { action: string; entityId?: string | null }) => { audit.push(e); } } },
    ], { SMS_FILE_STORAGE_DIR: dir });
    store = t.app.get(FILE_STORE);
    seed = await Seed.connect(db.url);
    registrar = await seed.user(['REGISTRAR']);
    teacher = await seed.user(['TEACHER']);
    bursar = await seed.user(['BURSAR']);

    const s1 = await seed.student('Ama', 'Mensah');
    const s2 = await seed.student('Yaw', 'Boateng');
    hiddenStudents.add(s2);

    const mk = async (scan: string, studentId: string, name = 'birth cert "Ama".pdf') => {
      const key = generateStorageKey();
      await store.put(key, Buffer.from('%PDF-1.4 fake'), 'application/pdf');
      const id = await seed.file(key, { scan, name, size: 13 });
      await seed.q(`INSERT INTO student_documents (student_id, file_id, doc_type) VALUES ($1, $2, 'birth_certificate')`, [studentId, id]);
      return id;
    };
    docFileId = await mk('clean', s1);
    pendingFileId = await mk('pending', s1);
    infectedFileId = await mk('infected', s1);
    hiddenFileId = await mk('clean', s2);

    const logoKey = generateStorageKey();
    await store.put(logoKey, Buffer.from([0x89, 0x50]), 'image/png');
    logoFileId = await seed.file(logoKey, { name: 'logo.png', mime: 'image/png', size: 2 });
    await seed.q(`UPDATE school_profile SET logo_file_id = $1`, [logoFileId]);
  });

  afterAll(async () => {
    await seed?.end();
    await t?.app.close();
    await db?.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('requires sign-in', async () => {
    t.currentUser.value = null;
    await http().get(`/api/v1/files/${docFileId}`).expect(401);
  });

  it('serves a clean file as an attachment with nosniff and audits the view', async () => {
    t.currentUser.value = registrar;
    const res = await http().get(`/api/v1/files/${docFileId}`).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="birth cert Ama.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(res.body as Buffer).toString()).toBe('%PDF-1.4 fake');
    expect(audit).toContainEqual(expect.objectContaining({ action: 'view', entityType: 'file', entityId: docFileId }));
  });

  it('returns 404 when the role cannot read the owning record (teacher, bursar)', async () => {
    t.currentUser.value = teacher;
    await http().get(`/api/v1/files/${docFileId}`).expect(404);
    t.currentUser.value = bursar;
    await http().get(`/api/v1/files/${docFileId}`).expect(404);
  });

  it('returns 404 for a student outside the user scope (IDOR)', async () => {
    t.currentUser.value = registrar;
    await http().get(`/api/v1/files/${hiddenFileId}`).expect(404);
  });

  it('refuses files not yet scanned or infected', async () => {
    t.currentUser.value = registrar;
    const p = await http().get(`/api/v1/files/${pendingFileId}`).expect(409);
    expect(p.body.code).toBe('FILE_NOT_READY');
    const i = await http().get(`/api/v1/files/${infectedFileId}`).expect(410);
    expect(i.body.code).toBe('FILE_INFECTED');
  });

  it('returns 404 for unknown and malformed ids', async () => {
    t.currentUser.value = registrar;
    await http().get('/api/v1/files/0190a1b2-0000-7000-8000-000000000000').expect(404);
    await http().get('/api/v1/files/..%2F..%2Fetc%2Fpasswd').expect(404);
  });

  it('lets any signed-in user fetch the school logo', async () => {
    t.currentUser.value = teacher;
    const res = await http().get(`/api/v1/files/${logoFileId}`).expect(200);
    expect(res.headers['content-type']).toContain('image/png');
  });
});
