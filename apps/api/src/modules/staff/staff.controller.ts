// Owner: Agent B.
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { parseIfMatch } from '../settings/common/http';
import { AssignmentsBody, CreateStaffBody, ListStaffQuery, RevealBody, StaffContactsBody, StaffService, UpdateStaffBody } from './staff.service';

const ArchiveBody = z.strictObject({ reason: z.string().trim().min(5).max(300) });

@Controller('staff')
export class StaffController {
  constructor(private readonly svc: StaffService) {}

  @Get()
  @RequirePermission('staff:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.list(user, parseWith(ListStaffQuery, q)); }

  @Post()
  @RequirePermission('staff:create')
  @Audited('create', 'staff')
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.create(parseWith(CreateStaffBody, body), user); }

  @Get(':id')
  @RequirePermission('staff:read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.get(id, user); }

  @Patch(':id')
  @RequirePermission('staff:update')
  @Audited('update', 'staff')
  update(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') ifMatch: string | undefined, @CurrentUser() user: AuthUser) {
    const parsed = parseWith(UpdateStaffBody, body);
    return this.svc.update(id, parsed, parseIfMatch(ifMatch), user);
  }

  @Post(':id/archive')
  @HttpCode(204)
  @RequirePermission('staff:archive')
  @Audited('archive', 'staff')
  async archive(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { await this.svc.archive(id, parseWith(ArchiveBody, body).reason, user); }

  @Put(':id/emergency-contacts')
  @RequirePermission('staff:update')
  @Audited('update', 'staff_emergency_contacts')
  contacts(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.replaceContacts(id, parseWith(StaffContactsBody, body), user); }

  @Get(':id/assignments')
  @RequirePermission('staff:read')
  assignments(@Param('id') id: string) { return this.svc.listAssignments(id); }

  @Put(':id/assignments')
  @RequirePermission('staff:update')
  @Audited('update', 'staff_assignments')
  replaceAssignments(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.replaceAssignments(id, parseWith(AssignmentsBody, body), user); }

  @Post(':id/sensitive/reveal')
  @HttpCode(200)
  @RequirePermission('staff_sensitive:reveal')
  @Audited('reveal_sensitive', 'staff')
  reveal(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.reveal(id, parseWith(RevealBody, body), user); }
}
