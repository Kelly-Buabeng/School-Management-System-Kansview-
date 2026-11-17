// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Injectable, Module } from '@nestjs/common';
import { STUDENT_LOOKUP, IMPORT_TARGET, type StudentLookup, type StudentBillingInfo, type ImportTarget } from '../../common/contracts';
import { AppError } from '../../common/app-error';

// SCAFFOLD STUB(S): replace with the real implementation and update the binding below.
@Injectable()
export class StubStudentLookup implements StudentLookup {
  async getBillingInfo(): Promise<StudentBillingInfo | null> { return null; }
  async listActiveStudentIds(): Promise<string[]> { return []; }
  async smsRecipients(): Promise<Array<{ guardianId: string; phone: string }>> { return []; }
}
@Injectable()
export class StubImportTarget implements ImportTarget {
  async upsertStudentWithGuardians(): Promise<never> { throw new AppError(501, 'NOT_IMPLEMENTED', 'Student import target not implemented yet'); }
}

@Global()
@Module({
  providers: [{ provide: STUDENT_LOOKUP, useClass: StubStudentLookup }, { provide: IMPORT_TARGET, useClass: StubImportTarget }],
  exports: [STUDENT_LOOKUP, IMPORT_TARGET],
})
export class StudentsModule {}
