// Owner: Agent F. Payment receipt (A5 or 80 mm thermal). Consumer: Agent C (finance).
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  amountInWords, BASE_STYLES, formatDateTime, IsoDateTimeSchema, keyValues, money, PesewasSchema, SchoolHeaderSchema,
  schoolHeader, StudentRefSchema, type DocTemplate,
} from './common';

export const ReceiptDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  /** 'a5' (default) or 'thermal80' for 80 mm roll printers. */
  format: z.enum(['a5', 'thermal80']).default('a5'),
  receiptNo: z.string().min(1),
  issuedAt: IsoDateTimeSchema,
  student: StudentRefSchema,
  payer: z.strictObject({ name: z.string().min(1), phone: z.string().nullish() }).nullish(),
  /** e.g. 'Cash', 'Mobile Money', 'Bank deposit', 'Cheque'. */
  method: z.string().min(1),
  reference: z.string().nullish(),
  amountPesewas: PesewasSchema,
  allocations: z.array(z.strictObject({
    description: z.string().min(1),
    termName: z.string().nullish(),
    amountPesewas: PesewasSchema,
  })).default([]),
  balanceAfterPesewas: PesewasSchema.nullish(),
  receivedBy: z.string().min(1),
  notes: z.string().nullish(),
  /** Present when the payment has been reversed; the PDF is then watermarked REVERSED automatically. */
  reversal: z.strictObject({ reversedAt: IsoDateTimeSchema, reason: z.string(), reversalNo: z.string().nullish() }).nullish(),
});
export type ReceiptData = z.input<typeof ReceiptDataSchema>;
type Parsed = z.output<typeof ReceiptDataSchema>;

const THERMAL_WIDTH = 226.77; // 80 mm in points

export const receiptTemplate: DocTemplate<Parsed> = {
  schema: ReceiptDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const thermal = d.format === 'thermal80';
    const fs = thermal ? 8 : 10;
    const align = thermal ? 'center' : 'left';
    const allocRows: TableCell[][] = d.allocations.map((a) => [
      { text: a.termName ? `${a.description} (${a.termName})` : a.description, fontSize: fs },
      { text: money(a.amountPesewas), alignment: 'right', fontSize: fs },
    ]);
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'OFFICIAL RECEIPT', { compact: thermal }),
      { text: `Receipt No: ${d.receiptNo}`, bold: true, fontSize: fs + 1, alignment: align },
      { text: formatDateTime(d.issuedAt), fontSize: fs, alignment: align, margin: [0, 0, 0, 6] },
      keyValues([
        ['Student', d.student.fullName],
        ['Student ID', d.student.code],
        ['Class', d.student.className],
        ['Paid by', d.payer ? [d.payer.name, d.payer.phone].filter(Boolean).join(', ') : null],
        ['Method', d.method],
        ['Reference', d.reference],
      ], { fontSize: fs }),
    ];
    if (allocRows.length) {
      content.push({
        table: {
          widths: ['*', 'auto'],
          body: [[{ text: 'Applied to', style: 'tableHeader', fontSize: fs }, { text: 'Amount', style: 'tableHeader', fontSize: fs, alignment: 'right' }], ...allocRows],
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 6],
      });
    }
    content.push(
      { columns: [{ text: 'AMOUNT PAID', bold: true, fontSize: fs + 2 }, { text: money(d.amountPesewas), bold: true, fontSize: fs + 2, alignment: 'right' }] },
      { text: amountInWords(d.amountPesewas), italics: true, fontSize: fs - 1, margin: [0, 2, 0, 6] },
    );
    if (d.balanceAfterPesewas !== null && d.balanceAfterPesewas !== undefined) {
      content.push({ columns: [{ text: 'Balance remaining', fontSize: fs }, { text: money(d.balanceAfterPesewas), alignment: 'right', fontSize: fs }] });
    }
    if (d.reversal) {
      content.push({
        text: `REVERSED on ${formatDateTime(d.reversal.reversedAt)}${d.reversal.reversalNo ? ` (${d.reversal.reversalNo})` : ''}: ${d.reversal.reason}`,
        color: '#b00020', bold: true, fontSize: fs, margin: [0, 6, 0, 0],
      });
    }
    if (d.notes) content.push({ text: d.notes, fontSize: fs - 1, margin: [0, 6, 0, 0] });
    content.push(
      { text: `Received by: ${d.receivedBy}`, fontSize: fs, margin: [0, 10, 0, 0] },
      { text: 'Please keep this receipt. Thank you.', fontSize: fs - 1, italics: true, alignment: 'center', margin: [0, 8, 0, 0] },
    );
    return {
      pageSize: thermal ? { width: THERMAL_WIDTH, height: 'auto' } : 'A5',
      pageMargins: thermal ? [10, 10, 10, 10] : [30, 30, 30, 30],
      info: { title: `Receipt ${d.receiptNo}` },
      content,
      styles: { ...BASE_STYLES, schoolName: { fontSize: thermal ? 10 : 13, bold: true }, docTitle: { fontSize: thermal ? 10 : 12, bold: true } },
      defaultStyle: { fontSize: fs },
    };
  },
};
