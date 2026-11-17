// Owner: Agent F. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Injectable, Module } from '@nestjs/common';
import { FILE_STORE, type FileStore } from '../../common/contracts';
import { AppError } from '../../common/app-error';

// SCAFFOLD STUB(S): replace with the real implementation and update the binding below.
@Injectable()
export class StubFileStore implements FileStore {
  async put(): Promise<void> { throw new AppError(501, 'NOT_IMPLEMENTED', 'File storage not implemented yet'); }
  async get(): Promise<never> { throw new AppError(501, 'NOT_IMPLEMENTED', 'File storage not implemented yet'); }
  async stat(): Promise<null> { return null; }
  async quarantine(): Promise<void> { throw new AppError(501, 'NOT_IMPLEMENTED', 'File storage not implemented yet'); }
}

@Global()
@Module({
  providers: [{ provide: FILE_STORE, useClass: StubFileStore }],
  exports: [FILE_STORE],
})
export class FilesModule {}
