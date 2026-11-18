import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { FILE_STORE, type FileStore } from '../common/contracts/file-store';
import type { AcceptedFile, IncomingFile, UploadPipeline, UploadPolicy } from './upload-pipeline';
import { checkPdf, checkXlsx, sanitiseFileName, sniff, type SniffedType } from './file-sniffer';
import { ClamdClient, type ScanVerdict } from './clamav';

export type ScanStatus = AcceptedFile['scanStatus'];

/** Persistence of the `files` row. Kysely implementation in files-repository.ts; tests use an in-memory fake. */
export interface FileRecords {
  insert(row: {
    storageKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    scanStatus: ScanStatus;
    uploadedBy: string;
  }): Promise<string>;
  setScanStatus(id: string, status: ScanStatus): Promise<void>;
  listPending(limit: number): Promise<Array<{ id: string; storageKey: string }>>;
}
export const FILE_RECORDS = Symbol('FILE_RECORDS');

export interface Scanner {
  scan(data: Buffer): Promise<ScanVerdict>;
}
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');

/** Largest image (in pixels) sharp will decode: stops decompression bombs (e.g. a 50 000 × 50 000 PNG). */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Upload hardening (threat model 4.6):
 * 1. size limit per policy (413)               4. structural checks: PDF active content, XLSX zip bomb
 * 2. type from magic bytes, never from client  5. images re-encoded by sharp (drops EXIF/GPS and appended payloads)
 * 3. allow-list per policy (415)               6. stored under a random key; `files` row; ClamAV INSTREAM when enabled
 * Files stay unavailable for download until scan_status = 'clean'.
 */
@Injectable()
export class HardenedUploadPipeline implements UploadPipeline {
  private readonly logger = new Logger('UploadPipeline');
  private readonly clamEnabled: boolean;

  constructor(
    @Inject(APP_CONFIG) cfg: AppConfig,
    private readonly moduleRef: ModuleRef,
    @Inject(FILE_RECORDS) private readonly records: FileRecords,
    @Optional() @Inject(MALWARE_SCANNER) private scanner?: Scanner,
  ) {
    this.clamEnabled = cfg.SMS_CLAMAV_ENABLED;
    if (this.clamEnabled && !this.scanner) this.scanner = new ClamdClient(cfg.SMS_CLAMAV_HOST);
  }

  async accept(file: IncomingFile, policy: UploadPolicy, uploadedBy: string): Promise<AcceptedFile> {
    if (file.buffer.length > policy.maxBytes) {
      throw new AppError(413, ErrorCodes.FILE_TOO_LARGE, 'This file is too large',
        `The largest file allowed here is ${Math.floor(policy.maxBytes / (1024 * 1024))} MB.`);
    }
    const sniffed = sniff(file.buffer);
    if (!sniffed.type || !(policy.allowedTypes as readonly string[]).includes(sniffed.type)) {
      this.logger.warn({ reason: sniffed.reason ?? `type ${sniffed.type} not allowed`, uploadedBy }, 'upload rejected');
      throw new AppError(415, ErrorCodes.FILE_TYPE_NOT_ALLOWED, 'This type of file is not allowed',
        `Allowed here: ${policy.allowedTypes.map(friendlyType).join(', ')}.`);
    }

    const { data, mimeType } = await this.sanitise(file.buffer, sniffed.type, policy);

    let scanStatus: ScanStatus = 'clean';
    if (this.clamEnabled) {
      const verdict = await this.scanner!.scan(data);
      if (verdict.status === 'infected') {
        this.logger.warn({ signature: verdict.signature, uploadedBy }, 'infected upload rejected');
        throw new AppError(422, ErrorCodes.FILE_INFECTED, 'This file contains a virus and was not saved',
          'Ask the parent for a clean copy, or scan the original computer.');
      }
      if (verdict.status === 'error') {
        // Keep the file but unavailable (pending); the worker re-scans pending files.
        this.logger.error({ message: verdict.message }, 'malware scan unavailable; file kept as pending');
        scanStatus = 'pending';
      }
    }

    const sha256 = createHash('sha256').update(data).digest('hex');
    const storageKey = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
    await this.store().put(storageKey, data, mimeType);
    const fileId = await this.records.insert({
      storageKey,
      originalName: sanitiseFileName(file.originalName),
      mimeType,
      sizeBytes: data.length,
      sha256,
      scanStatus,
      uploadedBy,
    });
    return { fileId, mimeType, sizeBytes: data.length, sha256, scanStatus };
  }

  /** Worker hook: re-scan files left `pending` because clamd was down. */
  async rescanPending(limit = 50): Promise<number> {
    if (!this.clamEnabled) return 0;
    const pending = await this.records.listPending(limit);
    let done = 0;
    for (const f of pending) {
      const chunks: Buffer[] = [];
      for await (const c of await this.store().get(f.storageKey)) chunks.push(Buffer.from(c as Buffer));
      const v = await this.scanner!.scan(Buffer.concat(chunks));
      if (v.status === 'error') continue;
      if (v.status === 'infected') await this.store().quarantine(f.storageKey);
      await this.records.setScanStatus(f.id, v.status === 'clean' ? 'clean' : 'infected');
      done++;
    }
    return done;
  }

  private async sanitise(buf: Buffer, type: SniffedType, policy: UploadPolicy): Promise<{ data: Buffer; mimeType: SniffedType }> {
    if (type === 'application/pdf') {
      const problem = checkPdf(buf);
      if (problem) this.reject(problem);
      return { data: buf, mimeType: type };
    }
    if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const problem = checkXlsx(buf);
      if (problem) this.reject(problem);
      return { data: buf, mimeType: type };
    }
    if (type === 'text/csv') return { data: buf, mimeType: type };

    // Images: always decode and re-encode. sharp drops all metadata (EXIF, GPS, XMP, ICC comments) unless asked to keep it.
    const max = policy.reencodeImages ?? { maxWidth: 4000, maxHeight: 4000 };
    try {
      const img = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate() // apply EXIF orientation before the EXIF is dropped
        .resize({ width: max.maxWidth, height: max.maxHeight, fit: 'inside', withoutEnlargement: true });
      const data = type === 'image/png' ? await img.png({ compressionLevel: 9 }).toBuffer() : await img.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      return { data, mimeType: type };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'image could not be decoded');
      this.reject('image could not be decoded');
    }
  }

  private reject(reason: string): never {
    this.logger.warn({ reason }, 'upload rejected by content check');
    throw new AppError(415, ErrorCodes.FILE_TYPE_NOT_ALLOWED, 'This file could not be accepted',
      'The file looks damaged or contains content that is not allowed (for example scripts). Save it again as a plain PDF or photo and retry.');
  }

  private store(): FileStore {
    try {
      return this.moduleRef.get<FileStore>(FILE_STORE, { strict: false });
    } catch {
      throw new AppError(501, ErrorCodes.NOT_IMPLEMENTED, 'File storage is not available yet');
    }
  }
}

function friendlyType(t: string): string {
  return ({ 'image/jpeg': 'JPEG photo', 'image/png': 'PNG image', 'application/pdf': 'PDF', 'text/csv': 'CSV',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel (.xlsx)' } as Record<string, string>)[t] ?? t;
}
