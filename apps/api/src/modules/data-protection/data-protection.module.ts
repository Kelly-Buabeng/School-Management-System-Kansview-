// Owner: Agent D. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { DataProtectionController } from './data-protection.controller';
import { DataProtectionService } from './data-protection.service';

@Module({ controllers: [DataProtectionController], providers: [DataProtectionService] })
export class DataProtectionModule {}
