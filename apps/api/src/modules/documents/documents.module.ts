// Owner: Agent F. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { PDF_SERVICE } from '../../common/contracts';
import { PdfmakePdfService } from './pdf.service';
import { DbSchoolHeaderSource, SCHOOL_HEADER_SOURCE } from './school-header.source';

@Global()
@Module({
  providers: [
    { provide: SCHOOL_HEADER_SOURCE, useClass: DbSchoolHeaderSource },
    PdfmakePdfService,
    { provide: PDF_SERVICE, useExisting: PdfmakePdfService },
  ],
  exports: [PDF_SERVICE, PdfmakePdfService, SCHOOL_HEADER_SOURCE],
})
export class DocumentsModule {}
