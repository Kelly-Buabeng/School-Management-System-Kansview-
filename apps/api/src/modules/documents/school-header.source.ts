// Owner: Agent F.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FILE_STORE, type FileStore } from '../../common/contracts';
import { KYSELY, type Db } from '../../common/db/database.module';
import type { SchoolHeader } from './templates/common';

/** Supplies the school name, motto, contacts and logo printed on every PDF when the caller does not pass `school`. */
export interface SchoolHeaderSource {
  get(): Promise<SchoolHeader | null>;
}
export const SCHOOL_HEADER_SOURCE = Symbol('SCHOOL_HEADER_SOURCE');

const CACHE_MS = 60_000;

interface ProfileRow {
  name: string;
  motto: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  storage_key: string | null;
  mime_type: string | null;
}

/** Reads school_profile (singleton) and the logo file (only when scan_status = clean). Cached for one minute. */
@Injectable()
export class DbSchoolHeaderSource implements SchoolHeaderSource {
  private readonly logger = new Logger('SchoolHeaderSource');
  private cache: { at: number; value: SchoolHeader | null } | null = null;

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(FILE_STORE) private readonly files: FileStore,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  async get(): Promise<SchoolHeader | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const row: ProfileRow | undefined = await this.db.selectFrom('school_profile as sp')
      .leftJoin('files as f', (j) => j.onRef('f.id', '=', 'sp.logo_file_id').on('f.scan_status', '=', 'clean'))
      .select(['sp.name', 'sp.motto', 'sp.address', 'sp.phone', 'sp.email', 'f.storage_key', 'f.mime_type'])
      .executeTakeFirst();
    let value: SchoolHeader | null = null;
    if (row) {
      value = { name: row.name, motto: row.motto, address: row.address, phone: row.phone, email: row.email, logoDataUrl: null };
      if (row.storage_key && (row.mime_type === 'image/png' || row.mime_type === 'image/jpeg')) {
        try {
          const stream = await this.files.get(row.storage_key);
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(c as Buffer);
          value.logoDataUrl = `data:${row.mime_type};base64,${Buffer.concat(chunks).toString('base64')}`;
        } catch (err) {
          // Documents still print without the logo; the missing file is an ops problem worth a warning.
          this.logger.warn({ err, storageKey: row.storage_key }, 'school logo could not be read; printing without it');
        }
      }
    }
    this.cache = { at: Date.now(), value };
    return value;
  }
}
