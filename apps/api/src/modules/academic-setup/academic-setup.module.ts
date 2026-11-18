// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { AcademicSetupController } from './academic-setup.controller';
import { AcademicSetupService } from './academic-setup.service';

/** Global so other Agent B modules can ask for the current year/term. */
@Global()
@Module({ controllers: [AcademicSetupController], providers: [AcademicSetupService], exports: [AcademicSetupService] })
export class AcademicSetupModule {}
