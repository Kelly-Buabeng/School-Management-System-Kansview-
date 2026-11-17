export type PdfDocType =
  | 'receipt' | 'fee_statement' | 'guardian_statement' | 'arrears_notice' | 'invoice'
  | 'report_card' | 'class_report_cards' | 'transfer_letter' | 'subject_access_pack' | 'table_report';

/**
 * Renders a PDF from a typed data object. Each doc type's data shape is defined in
 * apps/api/src/modules/documents/templates/<docType>.ts by Agent F, agreed with the consumer.
 * Owner: Agent F.
 */
export interface PdfService {
  render(docType: PdfDocType, data: Record<string, unknown>, opts?: { watermark?: 'COPY' | 'REVERSED' | 'DRAFT' }): Promise<Buffer>;
}
export const PDF_SERVICE = Symbol('PDF_SERVICE');
