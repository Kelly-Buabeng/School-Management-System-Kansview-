// Owner: Agent B.
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { parseIfMatch } from '../settings/common/http';
import { GuardiansService } from './guardians.service';
import { GuardianInput, GuardianLinkInput, ListGuardiansQuery, MergeGuardiansBody, RevealBody, UpdateGuardianBody, UpdateLinkBody } from './guardians.dto';

@Controller()
export class GuardiansController {
  constructor(private readonly svc: GuardiansService) {}

  @Get('guardians')
  @RequirePermission('guardians:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.list(user, parseWith(ListGuardiansQuery, q)); }

  @Post('guardians')
  @RequirePermission('guardians:create')
  @Audited('create', 'guardian')
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.create(parseWith(GuardianInput, body), user); }

  @Post('guardians/merge')
  @HttpCode(200)
  @RequirePermission('guardians:update')
  @Audited('update', 'guardian')
  merge(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.merge(parseWith(MergeGuardiansBody, body), user); }

  @Get('guardians/:guardianId')
  @RequirePermission('guardians:read')
  @Audited('view', 'guardian')
  get(@Param('guardianId') id: string, @CurrentUser() user: AuthUser) { return this.svc.get(id, user); }

  @Patch('guardians/:guardianId')
  @RequirePermission('guardians:update')
  @Audited('update', 'guardian')
  update(@Param('guardianId') id: string, @Body() body: unknown, @Headers('if-match') ifMatch: string | undefined, @CurrentUser() user: AuthUser) {
    const parsed = parseWith(UpdateGuardianBody, body);
    return this.svc.update(id, parsed, parseIfMatch(ifMatch), user);
  }

  @Get('guardians/:guardianId/students')
  @RequirePermission('guardians:read')
  students(@Param('guardianId') id: string, @CurrentUser() user: AuthUser) { return this.svc.listStudents(id, user); }

  @Post('guardians/:guardianId/ghana-card/reveal')
  @HttpCode(200)
  @RequirePermission('ghana_card:reveal')
  @Audited('reveal_sensitive', 'guardian')
  reveal(@Param('guardianId') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.revealGhanaCard(id, parseWith(RevealBody, body).reason, user); }

  @Get('students/:id/guardians')
  @RequirePermission('guardians:read')
  forStudent(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listForStudent(id, user); }

  @Post('students/:id/guardians')
  @RequirePermission('guardians:update')
  @Audited('update', 'student_guardian')
  link(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.link(id, parseWith(GuardianLinkInput, body), user); }

  @Patch('students/:id/guardians/:guardianId')
  @RequirePermission('guardians:update')
  @Audited('update', 'student_guardian')
  updateLink(@Param('id') id: string, @Param('guardianId') gid: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.updateLink(id, gid, parseWith(UpdateLinkBody, body), user);
  }

  @Delete('students/:id/guardians/:guardianId')
  @HttpCode(204)
  @RequirePermission('guardians:update')
  @Audited('update', 'student_guardian')
  async unlink(@Param('id') id: string, @Param('guardianId') gid: string, @CurrentUser() user: AuthUser) { await this.svc.unlink(id, gid, user); }
}
