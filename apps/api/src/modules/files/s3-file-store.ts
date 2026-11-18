// Owner: Agent F.
/**
 * S3-compatible FileStore adapter: INTERFACE STUB, NOT WIRED.
 *
 * v1 runs on-premise with LocalFileStore (CR-0002). When the school moves storage to an S3-compatible service
 * (AWS S3, MinIO, Wasabi, Backblaze B2), implement this class and bind it in files.module.ts when
 * SMS_FILE_STORAGE_DRIVER=s3 (new config key, via change request). Mapping:
 *
 *   put(key, data, type)  → PutObject  { Bucket, Key: `objects/${key}`, Body: data, ContentType: type,
 *                                        ServerSideEncryption: 'AES256', ChecksumSHA256 }
 *   get(key)              → GetObject  (return the Body stream; map NoSuchKey to AppError.notFound('file'))
 *   stat(key)             → HeadObject (ContentLength; NotFound → null)
 *   quarantine(key)       → CopyObject to `quarantine/${key}` then DeleteObject `objects/${key}`
 *
 * Keys keep the same validation as the local store (assertValidStorageKey). The bucket must block public access;
 * downloads always go through GET /files/{id} so permissions and audit apply. Credentials come from *_FILE secrets,
 * never from the database or code.
 */
import type { Readable } from 'node:stream';
import { AppError } from '../../common/app-error';
import type { FileStore } from '../../common/contracts';

export interface S3FileStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdFile: string;
  secretAccessKeyFile: string;
  forcePathStyle?: boolean;
}

export class S3FileStore implements FileStore {
  constructor(readonly options: S3FileStoreOptions) {}

  private notReady(): never {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'Cloud file storage is not set up');
  }
  async put(_key: string, _data: Buffer, _contentType: string): Promise<void> { this.notReady(); }
  async get(_key: string): Promise<Readable> { this.notReady(); }
  async stat(_key: string): Promise<{ sizeBytes: number } | null> { this.notReady(); }
  async quarantine(_key: string): Promise<void> { this.notReady(); }
}
