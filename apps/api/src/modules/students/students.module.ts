// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { IMPORT_TARGET, STUDENT_LOOKUP } from '../../common/contracts';
import { GuardianWriter } from '../guardians/guardian-writer';
import { AdmissionService } from './admission.service';
import { SafetyWriter } from './safety-writer';
import { StudentReader } from './student-reader';
import { StudentImportTarget, StudentLookupService } from './student-lookup.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

/**
 * Global: exports the StudentLookup / ImportTarget contracts (tokens) for other agents,
 * and the shared student read/write services for Agent B's other modules.
 */
@Global()
@Module({
  controllers: [StudentsController],
  providers: [
    StudentsService, StudentReader, AdmissionService, SafetyWriter, GuardianWriter,
    { provide: STUDENT_LOOKUP, useClass: StudentLookupService },
    { provide: IMPORT_TARGET, useClass: StudentImportTarget },
  ],
  exports: [STUDENT_LOOKUP, IMPORT_TARGET, StudentReader, AdmissionService, SafetyWriter, GuardianWriter, StudentsService],
})
export class StudentsModule {}
