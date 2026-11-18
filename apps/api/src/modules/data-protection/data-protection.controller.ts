import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { AnonymiseBody, CreateDsrBody, DataProtectionService, ListDsrQuery, RetentionQuery, UpdateDsrBody } from './data-protection.service';

const uuid = new ParseUUIDPipe({ errorHttpStatusCode: 404 });

/** openapi tag `data-protection` (Act 843). All writes and exports are audited by the service. */
@Controller()
export class DataProtectionController {
  constructor(private readonly dpa: DataProtectionService) {}

  @Get('data-subject-requests')
  @RequirePermission('dpa:read')
  list(@Query() q: unknown) {
    return this.dpa.list(parseWith(ListDsrQuery, q));
  }

  @Post('data-subject-requests')
  @RequirePermission('dpa:create')
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.dpa.create(parseWith(CreateDsrBody, body), user);
  }

  @Patch('data-subject-requests/:id')
  @RequirePermission('dpa:update')
  update(@Param('id', uuid) id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.dpa.update(id, parseWith(UpdateDsrBody, body), user);
  }

  @Post('students/:id/subject-access-export')
  @RequirePermission('dpa:export')
  @HttpCode(202)
  exportStudent(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    return this.dpa.subjectAccessExport(id, user);
  }

  @Get('retention/candidates')
  @RequirePermission('dpa:read')
  candidates(@Query() q: unknown) {
    return this.dpa.retentionCandidates(parseWith(RetentionQuery, q));
  }

  @Post('students/:id/anonymise')
  @RequirePermission('dpa:anonymise')
  @HttpCode(200)
  anonymise(@Param('id', uuid) id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.dpa.anonymiseStudent(id, parseWith(AnonymiseBody, body), user);
  }
}
