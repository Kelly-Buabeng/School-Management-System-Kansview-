// Owner: Agent D. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { AuditChainJob } from './audit-chain.job';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit.service';

/** AuditChainJob schedules the daily chain check and head anchor in the worker (pg-boss queue `audit-verify-chain`). */
@Module({ controllers: [AuditController], providers: [AuditQueryService, AuditChainJob], exports: [AuditQueryService, AuditChainJob] })
export class AuditModule {}
