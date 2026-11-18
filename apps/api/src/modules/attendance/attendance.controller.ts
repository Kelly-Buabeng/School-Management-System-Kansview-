// Owner: Agent B.
import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { AttendanceService, RegisterQuery, SaveRegisterBody, SummaryQuery } from './attendance.service';

@Controller()
export class AttendanceController {
  constructor(private readonly svc: AttendanceService) {}

  @Get('classes/:id/attendance')
  @RequirePermission('attendance:read')
  get(@Param('id') id: string, @Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.register(id, parseWith(RegisterQuery, q), user); }

  @Put('classes/:id/attendance')
  @RequirePermission('attendance:update')
  @Audited('update', 'attendance_session')
  save(@Param('id') id: string, @Query() q: unknown, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.save(id, parseWith(RegisterQuery, q), parseWith(SaveRegisterBody, body), user);
  }

  @Get('attendance/summary')
  @RequirePermission('attendance:read')
  summary(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.summary(user, parseWith(SummaryQuery, q)); }
}
