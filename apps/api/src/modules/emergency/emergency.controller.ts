// Owner: Agent B.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { EmergencyService } from './emergency.service';
import { ArchivePickupQuery, CreatePickupBody, LogContactBody, ReplaceContactsBody, UpdatePickupBody } from './emergency.dto';

@Controller('students/:id')
export class EmergencyController {
  constructor(private readonly svc: EmergencyService) {}

  @Get('emergency-view')
  @RequirePermission('emergency_view:read')
  @Audited('emergency_view', 'student')
  view(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.view(id, user); }

  @Get('emergency-contacts')
  @RequirePermission('students:read')
  contacts(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listContacts(id, user); }

  @Put('emergency-contacts')
  @RequirePermission('students:update')
  @Audited('update', 'emergency_contacts')
  replace(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.replaceContacts(id, parseWith(ReplaceContactsBody, body), user); }

  @Get('emergency-contact-logs')
  @RequirePermission('emergency_log:read')
  logs(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listLogs(id, user); }

  @Post('emergency-contact-logs')
  @RequirePermission('emergency_log:create')
  log(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.logContact(id, parseWith(LogContactBody, body), user); }

  @Get('pickups')
  @RequirePermission('pickups:read')
  pickups(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listPickups(id, user); }

  @Post('pickups')
  @RequirePermission('pickups:create')
  @Audited('create', 'authorised_pickup')
  addPickup(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.addPickup(id, parseWith(CreatePickupBody, body), user); }

  @Patch('pickups/:pickupId')
  @RequirePermission('pickups:update')
  @Audited('update', 'authorised_pickup')
  updatePickup(@Param('id') id: string, @Param('pickupId') pid: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.updatePickup(id, pid, parseWith(UpdatePickupBody, body), user);
  }

  @Delete('pickups/:pickupId')
  @HttpCode(204)
  @RequirePermission('pickups:archive')
  @Audited('archive', 'authorised_pickup')
  async archivePickup(@Param('id') id: string, @Param('pickupId') pid: string, @Query() q: unknown, @CurrentUser() user: AuthUser) {
    await this.svc.archivePickup(id, pid, parseWith(ArchivePickupQuery, q).reason, user);
  }
}
