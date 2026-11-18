// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { RecordAccess } from './common/record-access';

/** Global so every Agent B module can read policies and use RecordAccess without re-importing. */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, RecordAccess],
  exports: [SettingsService, RecordAccess],
})
export class SettingsModule {}
