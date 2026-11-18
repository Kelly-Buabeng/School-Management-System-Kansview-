// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

@Module({ controllers: [AttendanceController], providers: [AttendanceService], exports: [AttendanceService] })
export class AttendanceModule {}
