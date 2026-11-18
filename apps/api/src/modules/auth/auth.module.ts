// Owner: Agent D. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
