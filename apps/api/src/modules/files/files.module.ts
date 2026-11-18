// Owner: Agent F. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import { FILE_STORE } from '../../common/contracts';
import { FileAccessResolver } from './file-access.resolver';
import { FilesController } from './files.controller';
import { LocalFileStore } from './local-file-store';

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    FileAccessResolver,
    // Local volume in v1. S3-compatible adapter is documented in s3-file-store.ts and not wired yet.
    { provide: FILE_STORE, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => new LocalFileStore(cfg.SMS_FILE_STORAGE_DIR) },
  ],
  exports: [FILE_STORE, FileAccessResolver],
})
export class FilesModule {}
