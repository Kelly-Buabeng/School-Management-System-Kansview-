// Owner: Agent B.
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { parseIfMatch } from '../settings/common/http';
import { StudentsService, type UploadedBlob } from './students.service';
import { AdmitStudentBody, ArchiveBody, DuplicateCheckBody, ListStudentsQuery, StudentMedicalInput, UpdateStudentBody, UploadDocumentBody } from './students.dto';

const etag = (res: Response, dto: unknown) => {
  const v = (dto as { version?: number }).version;
  if (typeof v === 'number') res.setHeader('ETag', `"${v}"`);
  return dto;
};

@Controller('students')
export class StudentsController {
  constructor(private readonly svc: StudentsService) {}

  @Get()
  @RequirePermission('students:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.list(user, parseWith(ListStudentsQuery, q)); }

  @Post()
  @RequirePermission('students:create')
  @Audited('create', 'student')
  async admit(@Body() body: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return etag(res, await this.svc.admit(parseWith(AdmitStudentBody, body), user));
  }

  @Post('duplicate-check')
  @HttpCode(200)
  @RequirePermission('students:create')
  duplicateCheck(@Body() body: unknown) { return this.svc.duplicateCheck(parseWith(DuplicateCheckBody, body)); }

  @Get(':id')
  @RequirePermission('students:read')
  @Audited('view', 'student')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return etag(res, await this.svc.get(id, user));
  }

  @Patch(':id')
  @RequirePermission('students:update')
  @Audited('update', 'student')
  async update(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') ifMatch: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    if (body && typeof body === 'object' && ('studentCode' in body || 'student_code' in body)) {
      throw new AppError(422, ErrorCodes.STUDENT_CODE_IMMUTABLE, 'The student ID cannot be changed', 'Student IDs are permanent. Archive a record entered by mistake instead.');
    }
    const parsed = parseWith(UpdateStudentBody, body);
    return etag(res, await this.svc.update(id, parsed, parseIfMatch(ifMatch), user));
  }

  @Post(':id/archive')
  @HttpCode(204)
  @RequirePermission('students:archive')
  @Audited('archive', 'student')
  async archive(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.svc.archive(id, parseWith(ArchiveBody, body).reason, user);
  }

  @Put(':id/photo')
  @RequirePermission('students:update')
  @Audited('update', 'student')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  photo(@Param('id') id: string, @UploadedFile() file: UploadedBlob | undefined, @CurrentUser() user: AuthUser) { return this.svc.uploadPhoto(id, file, user); }

  @Get(':id/medical')
  @RequirePermission('medical:read')
  @Audited('view', 'student_medical')
  medical(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.getMedical(id, user); }

  @Put(':id/medical')
  @RequirePermission('medical:update')
  @Audited('update', 'student_medical')
  putMedical(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.putMedical(id, parseWith(StudentMedicalInput, body), user); }

  @Get(':id/documents')
  @RequirePermission('student_documents:read')
  documents(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listDocuments(id, user); }

  @Post(':id/documents')
  @RequirePermission('student_documents:create')
  @Audited('create', 'student_document')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  upload(@Param('id') id: string, @UploadedFile() file: UploadedBlob | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.uploadDocument(id, file, parseWith(UploadDocumentBody, body), user);
  }

  @Post(':id/documents/:documentId/archive')
  @HttpCode(204)
  @RequirePermission('student_documents:archive')
  @Audited('archive', 'student_document')
  async archiveDocument(@Param('id') id: string, @Param('documentId') documentId: string, @CurrentUser() user: AuthUser) {
    await this.svc.archiveDocument(id, documentId, user);
  }

  @Get(':id/siblings')
  @RequirePermission('students:read')
  siblings(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.siblings(id, user); }

  @Get(':id/status-history')
  @RequirePermission('students:read')
  history(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.statusHistory(id, user); }
}
