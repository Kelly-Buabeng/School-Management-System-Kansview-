// Owner: Agent F.
import { Controller, Get, Inject, Logger, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AppError } from '../../common/app-error';
import { FILE_STORE, type FileStore } from '../../common/contracts';
import { KYSELY, type Db } from '../../common/db/database.module';
import { Access, Audited, AUDIT_SERVICE, CurrentUser, type AuditService, type AuthUser } from '../../security';
import { FileAccessResolver } from './file-access.resolver';

const Id = z.uuid();

/** ASCII-only fallback name plus RFC 5987 UTF-8 name; strips quotes, control characters and path separators. */
export function contentDisposition(originalName: string): string {
  const base = originalName.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"]/g, '').trim() || 'download';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

@Controller('files')
export class FilesController {
  private readonly logger = new Logger('FilesController');

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(FILE_STORE) private readonly store: FileStore,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    private readonly access: FileAccessResolver,
  ) {}

  @Get(':id')
  @Access('inherits-from-owning-record')
  @Audited('view', 'file')
  async download(@Param('id') idParam: string, @CurrentUser() user: AuthUser, @Res() res: Response): Promise<void> {
    const parsed = Id.safeParse(idParam);
    if (!parsed.success) throw AppError.notFound('file');
    const id = parsed.data;
    const file = await this.db.selectFrom('files')
      .select(['id', 'storage_key', 'original_name', 'mime_type', 'size_bytes', 'scan_status', 'uploaded_by', 'archived_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!file || file.archived_at) throw AppError.notFound('file');

    // Out of scope or no permission on the owning record → 404, so file ids cannot be probed.
    const owner = await this.access.authorise(user, id, file.uploaded_by);
    if (!owner) throw AppError.notFound('file');

    if (file.scan_status === 'infected') {
      throw new AppError(410, 'FILE_INFECTED', 'This file was blocked because it may contain a virus');
    }
    if (file.scan_status !== 'clean') {
      throw new AppError(409, 'FILE_NOT_READY', 'This file is still being checked. Please try again in a minute.');
    }
    const stat = await this.store.stat(file.storage_key);
    if (!stat) {
      this.logger.error({ fileId: id }, 'file record exists but stored object is missing');
      throw AppError.notFound('file');
    }

    await this.audit.record({ action: 'view', entityType: 'file', entityId: id, studentId: owner.studentId ?? null, reason: owner.kind }, user);

    const stream = await this.store.get(file.storage_key);
    res.status(200);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', String(stat.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(file.original_name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await pipeline(stream, res);
  }
}
