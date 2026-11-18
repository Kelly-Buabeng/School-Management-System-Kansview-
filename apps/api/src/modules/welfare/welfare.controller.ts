// Owner: Agent B.
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { HealthVisitBody, IncidentBody, ListIncidentsQuery, UpdateHealthVisitBody, UpdateIncidentBody, WelfareService } from './welfare.service';

@Controller()
export class WelfareController {
  constructor(private readonly svc: WelfareService) {}

  @Get('students/:id/incidents')
  @RequirePermission('incidents:read')
  @Audited('view', 'incidents')
  incidents(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listForStudent(id, user); }

  @Post('students/:id/incidents')
  @RequirePermission('incidents:create')
  @Audited('create', 'incident')
  create(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.createIncident(id, parseWith(IncidentBody, body), user); }

  @Patch('incidents/:id')
  @RequirePermission('incidents:update')
  @Audited('update', 'incident')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateIncident(id, parseWith(UpdateIncidentBody, body), user); }

  @Get('incidents')
  @RequirePermission('incidents:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.list(user, parseWith(ListIncidentsQuery, q)); }

  @Get('students/:id/health-visits')
  @RequirePermission('health_visits:read')
  @Audited('view', 'health_visits')
  visits(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.listVisits(id, user); }

  @Post('students/:id/health-visits')
  @RequirePermission('health_visits:create')
  @Audited('create', 'health_visit')
  createVisit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.createVisit(id, parseWith(HealthVisitBody, body), user); }

  @Patch('health-visits/:id')
  @RequirePermission('health_visits:update')
  @Audited('update', 'health_visit')
  updateVisit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateVisit(id, parseWith(UpdateHealthVisitBody, body), user); }
}
