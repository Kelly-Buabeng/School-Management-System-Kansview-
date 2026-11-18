// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Controller, Get, Module } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get()
  @RequirePermission('dashboard:read')
  get(@CurrentUser() user: AuthUser) { return this.svc.get(user); }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
