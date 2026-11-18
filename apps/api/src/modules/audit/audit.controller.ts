import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { RequirePermission } from '../../security/decorators';
import { AuditQueryService, ListAuditQuery } from './audit.service';

/** openapi tag `audit`. Read-only views of audit.events. */
@Controller('audit-events')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @RequirePermission('audit:read')
  list(@Query() query: unknown) {
    return this.audit.list(parseWith(ListAuditQuery, query));
  }

  @Post('verify')
  @RequirePermission('audit:read')
  @HttpCode(200)
  verify() {
    return this.audit.verify();
  }
}
