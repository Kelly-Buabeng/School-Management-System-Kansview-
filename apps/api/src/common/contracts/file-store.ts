import type { Readable } from 'node:stream';

/** Raw object storage (local volume now, S3-compatible later). No access control here; callers check permissions. Owner: Agent F. */
export interface FileStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** Moves an object to quarantine (infected uploads). */
  quarantine(key: string): Promise<void>;
}
export const FILE_STORE = Symbol('FILE_STORE');
