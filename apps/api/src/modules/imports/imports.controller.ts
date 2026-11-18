import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { PageQuery } from '../../common/pagination';
import { parseWith } from '../../common/validation';
import { CurrentUser, IDEMPOTENCY_SERVICE, RequirePermission, Audited, UPLOAD_POLICIES, type AuthUser, type IdempotencyService } from '../../security';
import { IMPORT_TYPES } from './import-columns';
import { ImportsService, type UploadedFile as ImportUpload } from './imports.service';
import { templateFileName } from './template-builder';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TypeParam = z.enum(IMPORT_TYPES);
const UploadBody = z.strictObject({ type: TypeParam });
const RowsQuery = PageQuery.extend({ status: z.enum(['valid', 'warning', 'error', 'duplicate']).optional() });
const ReportQuery = z.strictObject({ include: z.enum(['problems', 'all']).default('problems') });
const ResolveBody = z.strictObject({
  action: z.enum(['link_existing', 'create_new', 'skip', 'include']),
  existingId: z.uuid().optional(),
});
const RowNumberParam = z.coerce.number().int().min(1).max(1_000_000);
/** Commit takes no options; an empty JSON object (or no body) is accepted. */
const CommitBody = z.strictObject({}).optional();

function download(res: Response, buffer: Buffer, fileName: string): StreamableFile {
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(buffer, { type: XLSX, length: buffer.length });
}

@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IdempotencyService,
  ) {}

  @Get('templates/:type')
  @RequirePermission('imports:create')
  async template(@Param('type') type: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const t = parseWith(TypeParam, type);
    return download(res, await this.imports.template(t, user), templateFileName(t));
  }

  @Get()
  @RequirePermission('imports:read')
  list(@Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.imports.list(user, parseWith(PageQuery, query));
  }

  @Post()
  @RequirePermission('imports:create')
  @Audited('create', 'import_job')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_POLICIES.importFile.maxBytes, files: 1, fields: 5 } }))
  upload(@UploadedFile() file: ImportUpload | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { type } = parseWith(UploadBody, body);
    return this.imports.upload(type, file, user);
  }

  @Get(':id')
  @RequirePermission('imports:read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.imports.get(id, user);
  }

  /** Dry run. Runs synchronously (files are capped at 2,000 rows); 202 with the validated job and its totals. */
  @Post(':id/validate')
  @HttpCode(202)
  @RequirePermission('imports:create')
  validate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.imports.validate(id, user);
  }

  @Get(':id/rows')
  @RequirePermission('imports:read')
  rows(@Param('id') id: string, @Query() query: unknown, @CurrentUser() user: AuthUser) {
    const { status, ...page } = parseWith(RowsQuery, query);
    return this.imports.rows(id, user, status, page);
  }

  @Patch(':id/rows/:rowNumber')
  @RequirePermission('imports:create')
  resolve(@Param('id') id: string, @Param('rowNumber') rowNumber: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.imports.resolve(id, parseWith(RowNumberParam, rowNumber), parseWith(ResolveBody, body), user);
  }

  @Get(':id/error-report.xlsx')
  @RequirePermission('imports:read')
  @Audited('export', 'import_job')
  async errorReport(@Param('id') id: string, @Query() query: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { include } = parseWith(ReportQuery, query);
    const { buffer, fileName } = await this.imports.errorReport(id, user, include === 'all');
    return download(res, buffer, fileName);
  }

  @Post(':id/commit')
  @HttpCode(202)
  @RequirePermission('imports:commit')
  @Audited('create', 'import_commit')
  async commit(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    parseWith(CommitBody, body && Object.keys(body as object).length ? body : undefined);
    const result = await this.idempotency.run(key, `POST /imports/${id}/commit`, { id }, user, async () => ({ status: 202, body: await this.imports.commit(id, user) }));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status);
    return result.body;
  }
}
