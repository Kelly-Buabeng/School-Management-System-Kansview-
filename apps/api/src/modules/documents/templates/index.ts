// Owner: Agent F. Data shapes for every PdfDocType. Consumers import types from here, e.g.
//   import type { ReceiptData } from '../documents/templates';
//   await pdf.render('receipt', data satisfies ReceiptData);
import type { PdfDocType } from '../../../common/contracts';
import type { DocTemplate } from './common';
import { arrearsNoticeTemplate } from './arrears-notice';
import { classReportCardsTemplate } from './class-report-cards';
import { feeStatementTemplate } from './fee-statement';
import { guardianStatementTemplate } from './guardian-statement';
import { invoiceTemplate } from './invoice';
import { receiptTemplate } from './receipt';
import { reportCardTemplate } from './report-card';
import { subjectAccessPackTemplate } from './subject-access-pack';
import { tableReportTemplate } from './table-report';
import { transferLetterTemplate } from './transfer-letter';

export * from './common';
export * from './receipt';
export * from './fee-statement';
export * from './guardian-statement';
export * from './arrears-notice';
export * from './invoice';
export * from './report-card';
export * from './class-report-cards';
export * from './transfer-letter';
export * from './subject-access-pack';
export * from './table-report';

/** Maps each doc type to its data shape (input form: defaults may be omitted). */
export interface PdfDataByType {
  receipt: import('./receipt').ReceiptData;
  fee_statement: import('./fee-statement').FeeStatementData;
  guardian_statement: import('./guardian-statement').GuardianStatementData;
  arrears_notice: import('./arrears-notice').ArrearsNoticeData;
  invoice: import('./invoice').InvoiceData;
  report_card: import('./report-card').ReportCardData;
  class_report_cards: import('./class-report-cards').ClassReportCardsData;
  transfer_letter: import('./transfer-letter').TransferLetterData;
  subject_access_pack: import('./subject-access-pack').SubjectAccessPackData;
  table_report: import('./table-report').TableReportData;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PDF_TEMPLATES: Record<PdfDocType, DocTemplate<any>> = {
  receipt: receiptTemplate,
  fee_statement: feeStatementTemplate,
  guardian_statement: guardianStatementTemplate,
  arrears_notice: arrearsNoticeTemplate,
  invoice: invoiceTemplate,
  report_card: reportCardTemplate,
  class_report_cards: classReportCardsTemplate,
  transfer_letter: transferLetterTemplate,
  subject_access_pack: subjectAccessPackTemplate,
  table_report: tableReportTemplate,
};
