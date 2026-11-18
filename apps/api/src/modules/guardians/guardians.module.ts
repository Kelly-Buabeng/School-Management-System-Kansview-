// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { GuardiansController } from './guardians.controller';
import { GuardiansService } from './guardians.service';

@Module({ controllers: [GuardiansController], providers: [GuardiansService], exports: [GuardiansService] })
export class GuardiansModule {}
