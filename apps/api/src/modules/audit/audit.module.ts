// Owner: Agent D. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit.service';

/** Exports AuditQueryService so the worker can schedule `verifyAndLog()` daily (job name suggestion: `audit.verify-chain`). */
@Module({ controllers: [AuditController], providers: [AuditQueryService], exports: [AuditQueryService] })
export class AuditModule {}
