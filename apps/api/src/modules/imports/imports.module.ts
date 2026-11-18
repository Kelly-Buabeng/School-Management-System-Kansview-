// Owner: Agent G. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
