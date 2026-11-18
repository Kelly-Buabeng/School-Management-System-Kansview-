// Owner: Agent B.
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { ChangeClassBody, EnrolmentService, RenumberBody } from './enrolment.service';

@Controller()
export class EnrolmentController {
  constructor(private readonly svc: EnrolmentService) {}

  @Get('students/:id/enrolments')
  @RequirePermission('enrolments:read')
  history(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.history(id, user); }

  @Post('students/:id/change-class')
  @RequirePermission('enrolments:update')
  @Audited('update', 'enrolment')
  change(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.changeClass(id, parseWith(ChangeClassBody, body), user); }

  @Get('classes/:id/students')
  @RequirePermission('enrolments:read')
  roll(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.classStudents(id, user); }

  @Post('classes/:id/roll-numbers')
  @HttpCode(200)
  @RequirePermission('enrolments:update')
  @Audited('update', 'class_roll')
  renumber(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.renumber(id, parseWith(RenumberBody, body), user); }
}
