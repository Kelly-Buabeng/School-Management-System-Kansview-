// Owner: Agent F. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Injectable, Module } from '@nestjs/common';
import { PDF_SERVICE, type PdfService } from '../../common/contracts';
import { AppError } from '../../common/app-error';

// SCAFFOLD STUB(S): replace with the real implementation and update the binding below.
@Injectable()
export class StubPdfService implements PdfService {
  async render(): Promise<Buffer> { throw new AppError(501, 'NOT_IMPLEMENTED', 'PDF generation not implemented yet'); }
}

@Global()
@Module({
  providers: [{ provide: PDF_SERVICE, useClass: StubPdfService }],
  exports: [PDF_SERVICE],
})
export class DocumentsModule {}
