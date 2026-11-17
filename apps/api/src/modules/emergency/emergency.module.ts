// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { EmergencyController } from './emergency.controller';
import { EmergencyService } from './emergency.service';

@Module({ controllers: [EmergencyController], providers: [EmergencyService] })
export class EmergencyModule {}
