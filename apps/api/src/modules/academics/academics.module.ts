// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { AcademicsController } from './academics.controller';
import { AcademicsService } from './academics.service';

@Module({ controllers: [AcademicsController], providers: [AcademicsService] })
export class AcademicsModule {}
