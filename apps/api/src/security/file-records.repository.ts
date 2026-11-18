import { Inject, Injectable } from '@nestjs/common';
import { KYSELY, type Db } from '../common/db/database.module';
import type { FileRecords, ScanStatus } from './upload-pipeline.service';

/** Kysely implementation of the `files` row writes used by the upload pipeline. */
@Injectable()
export class DbFileRecords implements FileRecords {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async insert(row: Parameters<FileRecords['insert']>[0]): Promise<string> {
    const r = await this.db.insertInto('files').values({
      storage_key: row.storageKey,
      original_name: row.originalName,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      sha256: row.sha256,
      scan_status: row.scanStatus,
      scanned_at: row.scanStatus === 'pending' ? null : new Date(),
      uploaded_by: row.uploadedBy,
      created_by: row.uploadedBy,
    }).returning('id').executeTakeFirstOrThrow();
    return r.id;
  }

  async setScanStatus(id: string, status: ScanStatus): Promise<void> {
    await this.db.updateTable('files').set({ scan_status: status, scanned_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
  }

  async listPending(limit: number): Promise<Array<{ id: string; storageKey: string }>> {
    const rows = await this.db.selectFrom('files').select(['id', 'storage_key']).where('scan_status', '=', 'pending').orderBy('created_at').limit(limit).execute();
    return rows.map((r) => ({ id: r.id, storageKey: r.storage_key }));
  }
}
