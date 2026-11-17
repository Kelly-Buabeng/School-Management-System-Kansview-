import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateStorageKey, LocalFileStore } from './local-file-store';

async function readAll(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('LocalFileStore', () => {
  let dir: string;
  let store: LocalFileStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'f-store-'));
    store = new LocalFileStore(dir);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('generates random URL-safe keys', () => {
    const a = generateStorageKey();
    const b = generateStorageKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it('stores, stats and reads back an object in a sharded directory', async () => {
    const key = generateStorageKey();
    await store.put(key, Buffer.from('hello kansview'), 'text/plain');
    expect(store.objectPath(key)).toBe(join(dir, 'objects', key.slice(0, 2), key.slice(2, 4), key));
    expect(await store.stat(key)).toEqual({ sizeBytes: 14 });
    expect((await readAll(await store.get(key))).toString()).toBe('hello kansview');
    expect(await readdir(join(dir, 'tmp'))).toEqual([]); // no temp leftovers
  });

  it('overwrites atomically', async () => {
    const key = generateStorageKey();
    await store.put(key, Buffer.from('one'), 'text/plain');
    await store.put(key, Buffer.from('two'), 'text/plain');
    expect(await readFile(store.objectPath(key), 'utf8')).toBe('two');
  });

  it('returns null / 404 for missing objects', async () => {
    const key = generateStorageKey();
    expect(await store.stat(key)).toBeNull();
    await expect(store.get(key)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['../../etc/passwd', 'abc/def/ghi/jkl/mno', '..', '', 'short', 'a'.repeat(200), 'key with spaces in it ok', '%2e%2e%2f%2e%2e%2fetcpasswd'])(
    'rejects unsafe key %j', async (key) => {
      await expect(store.put(key, Buffer.from('x'), 'text/plain')).rejects.toMatchObject({ status: 400 });
      await expect(store.get(key)).rejects.toMatchObject({ status: 400 });
    },
  );

  it('moves infected objects to quarantine so they can no longer be read', async () => {
    const key = generateStorageKey();
    await store.put(key, Buffer.from('EICAR'), 'application/pdf');
    await store.quarantine(key);
    expect(await store.stat(key)).toBeNull();
    expect(await readFile(store.quarantinePath(key), 'utf8')).toBe('EICAR');
    await expect(store.quarantine(key)).rejects.toMatchObject({ status: 404 });
  });
});
