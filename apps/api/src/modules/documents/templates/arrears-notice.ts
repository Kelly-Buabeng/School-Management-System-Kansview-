// Owner: Agent F. Letter to a guardian about unpaid fees. Consumer: Agent C.
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  BASE_STYLES, formatDate, IsoDateSchema, money, PesewasSchema, SchoolHeaderSchema, schoolHeader, signatureBlock,
  SignatorySchema, standardFooter, StudentRefSchema, type DocTemplate,
} from './common';

export const ArrearsNoticeDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  noticeDate: IsoDateSchema,
  reference: z.string().nullish(),
  guardian: z.strictObject({ fullName: z.string().min(1), address: z.string().nullish() }),
  student: StudentRefSchema,
  items: z.array(z.strictObject({ termName: z.string(), description: z.string(), amountPesewas: PesewasSchema })).min(1),
  totalArrearsPesewas: PesewasSchema,
  dueDate: IsoDateSchema,
  /** Optional custom paragraph; a polite default is used otherwise. */
  message: z.string().nullish(),
  signatory: SignatorySchema,
});
export type ArrearsNoticeData = z.input<typeof ArrearsNoticeDataSchema>;
type Parsed = z.output<typeof ArrearsNoticeDataSchema>;

export const arrearsNoticeTemplate: DocTemplate<Parsed> = {
  schema: ArrearsNoticeDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const rows: TableCell[][] = [
      [{ text: 'Term', style: 'tableHeader' }, { text: 'Item', style: 'tableHeader' }, { text: 'Amount', style: 'tableHeader', alignment: 'right' }],
      ...d.items.map((i): TableCell[] => [i.termName, i.description, { text: money(i.amountPesewas), alignment: 'right' }]),
      [{ text: 'Total outstanding', bold: true, colSpan: 2 }, '', { text: money(d.totalArrearsPesewas), bold: true, alignment: 'right' }],
    ];
    const message = d.message ?? `Our records show that the fees listed below for ${d.student.fullName} are still outstanding. `
      + `Kindly settle the amount of ${money(d.totalArrearsPesewas)} on or before ${formatDate(d.dueDate)}. `
      + 'If you have already paid, please bring your receipt to the school office so we can update our records. Thank you.';
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'NOTICE OF OUTSTANDING FEES'),
      { text: formatDate(d.noticeDate), alignment: 'right' },
    ];
    if (d.reference) content.push({ text: `Ref: ${d.reference}`, alignment: 'right' });
    content.push({ text: d.guardian.fullName, bold: true, margin: [0, 8, 0, 0] });
    if (d.guardian.address) content.push({ text: d.guardian.address });
    content.push(
      { text: `Student: ${d.student.fullName} (${d.student.code})${d.student.className ? `, ${d.student.className}` : ''}`, margin: [0, 10, 0, 6] },
      { text: `Dear ${d.guardian.fullName},`, margin: [0, 0, 0, 6] },
      { text: message, margin: [0, 0, 0, 10], lineHeight: 1.2 },
      { table: { headerRows: 1, widths: [90, '*', 90], body: rows }, layout: 'lightHorizontalLines' },
      { text: `Due date: ${formatDate(d.dueDate)}`, bold: true, margin: [0, 10, 0, 0] },
      signatureBlock(d.signatory),
    );
    return {
      pageSize: 'A4', pageMargins: [50, 40, 50, 50], info: { title: `Arrears notice ${d.student.code}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 10.5 },
    };
  },
};
