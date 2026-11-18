// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { WelfareController } from './welfare.controller';
import { WelfareService } from './welfare.service';

@Module({ controllers: [WelfareController], providers: [WelfareService] })
export class WelfareModule {}
