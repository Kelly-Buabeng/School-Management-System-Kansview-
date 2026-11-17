// Owner: Agent F.
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { AppError } from '../../common/app-error';
import type { FileStore } from '../../common/contracts';

/**
 * Storage keys are random, URL-safe and never derived from user input (file names, student names).
 * The strict pattern makes path traversal impossible: no dots, no slashes, no separators of any kind.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** New random storage key (32 base64url chars = 192 bits). Use this for `files.storage_key`. */
export function generateStorageKey(): string {
  return randomBytes(24).toString('base64url');
}

export function assertValidStorageKey(key: string): void {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid file reference');
  }
}

/**
 * FileStore on a local (or mounted) volume.
 *
 * Layout under the root:
 *   objects/<k0k1>/<k2k3>/<key>   stored objects, sharded by the first four key characters
 *   quarantine/<key>              infected uploads; never served
 *   tmp/                          in-progress writes
 *
 * Writes are atomic: data goes to a temp file, is fsynced, renamed into place, then the directory is fsynced.
 * A crash leaves either the old state or the complete new object, never a partial file.
 */
export class LocalFileStore implements FileStore {
  private readonly logger = new Logger('LocalFileStore');
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** Absolute path for a key. Exposed for tests and ops tooling. */
  objectPath(key: string): string {
    assertValidStorageKey(key);
    const p = join(this.root, 'objects', key.slice(0, 2), key.slice(2, 4), key);
    this.assertInsideRoot(p);
    return p;
  }

  quarantinePath(key: string): string {
    assertValidStorageKey(key);
    const p = join(this.root, 'quarantine', key);
    this.assertInsideRoot(p);
    return p;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const target = this.objectPath(key);
    const tmpDir = join(this.root, 'tmp');
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = join(tmpDir, `${key}.${randomBytes(6).toString('hex')}.part`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      this.logger.error({ err, key }, 'could not move stored file into place');
      throw err;
    }
    await this.fsyncDir(dirname(target));
  }

  async get(key: string): Promise<Readable> {
    const p = this.objectPath(key);
    const s = await stat(p).catch(() => null);
    if (!s?.isFile()) throw AppError.notFound('file');
    return createReadStream(p);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    const s = await stat(this.objectPath(key)).catch(() => null);
    return s?.isFile() ? { sizeBytes: s.size } : null;
  }

  async quarantine(key: string): Promise<void> {
    const from = this.objectPath(key);
    const to = this.quarantinePath(key);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    try {
      await rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw AppError.notFound('file');
      throw err;
    }
    await this.fsyncDir(dirname(to));
    this.logger.warn({ key }, 'file moved to quarantine');
  }

  private assertInsideRoot(p: string): void {
    if (!resolve(p).startsWith(this.root + sep)) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid file reference');
  }

  private async fsyncDir(dir: string): Promise<void> {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } catch (err) {
      // Some filesystems (e.g. certain network mounts) do not support fsync on directories. The rename is still atomic.
      this.logger.debug({ err, dir }, 'directory fsync not supported');
    } finally {
      await fh.close();
    }
  }
}
