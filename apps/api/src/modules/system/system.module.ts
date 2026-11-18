// Owner: Agent H. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SystemController } from './system.controller';
import { SystemStatusService } from './system-status.service';
import { MaintenanceService } from './maintenance.service';

@Module({ controllers: [HealthController, SystemController], providers: [SystemStatusService, MaintenanceService] })
export class SystemModule {}
