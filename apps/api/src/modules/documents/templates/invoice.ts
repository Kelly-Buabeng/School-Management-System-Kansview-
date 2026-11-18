// Owner: Agent F. Term bill / invoice. Consumer: Agent C.
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  BASE_STYLES, formatDate, IsoDateSchema, keyValues, money, PesewasSchema, SchoolHeaderSchema, schoolHeader, standardFooter,
  StudentRefSchema, type DocTemplate,
} from './common';

export const InvoiceDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  invoiceNo: z.string().min(1),
  issueDate: IsoDateSchema,
  dueDate: IsoDateSchema.nullish(),
  termName: z.string().min(1),
  student: StudentRefSchema,
  billTo: z.strictObject({ name: z.string().min(1), phone: z.string().nullish() }).nullish(),
  lines: z.array(z.strictObject({ description: z.string().min(1), amountPesewas: PesewasSchema })).min(1),
  subtotalPesewas: PesewasSchema,
  discountPesewas: PesewasSchema.nullish(),
  totalPesewas: PesewasSchema,
  previousBalancePesewas: PesewasSchema.nullish(),
  amountDuePesewas: PesewasSchema,
  notes: z.string().nullish(),
  paymentInstructions: z.string().nullish(),
});
export type InvoiceData = z.input<typeof InvoiceDataSchema>;
type Parsed = z.output<typeof InvoiceDataSchema>;

export const invoiceTemplate: DocTemplate<Parsed> = {
  schema: InvoiceDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const right = (t: string, bold = false): TableCell => ({ text: t, alignment: 'right', bold });
    const body: TableCell[][] = [
      [{ text: 'Item', style: 'tableHeader' }, { text: 'Amount', style: 'tableHeader', alignment: 'right' }],
      ...d.lines.map((l): TableCell[] => [l.description, right(money(l.amountPesewas))]),
      [{ text: 'Subtotal', bold: true }, right(money(d.subtotalPesewas), true)],
    ];
    if (d.discountPesewas) body.push(['Discount / scholarship', right(`-${money(d.discountPesewas)}`)]);
    body.push([{ text: 'Total this term', bold: true }, right(money(d.totalPesewas), true)]);
    if (d.previousBalancePesewas) body.push(['Balance brought forward', right(money(d.previousBalancePesewas))]);
    body.push([{ text: 'AMOUNT DUE', bold: true, fontSize: 12 }, { text: money(d.amountDuePesewas), alignment: 'right', bold: true, fontSize: 12 }]);
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'INVOICE'),
      {
        columns: [
          keyValues([['Student', d.student.fullName], ['Student ID', d.student.code], ['Class', d.student.className],
            ['Bill to', d.billTo ? [d.billTo.name, d.billTo.phone].filter(Boolean).join(', ') : null]]),
          keyValues([['Invoice No', d.invoiceNo], ['Term', d.termName], ['Issued', formatDate(d.issueDate)], ['Due', formatDate(d.dueDate)]]),
        ],
      },
      { table: { headerRows: 1, widths: ['*', 110], body }, layout: 'lightHorizontalLines', margin: [0, 6, 0, 0] },
    ];
    if (d.paymentInstructions) content.push({ text: 'How to pay', bold: true, margin: [0, 12, 0, 2] }, { text: d.paymentInstructions });
    if (d.notes) content.push({ text: d.notes, fontSize: 9, margin: [0, 8, 0, 0] });
    return {
      pageSize: 'A4', pageMargins: [40, 40, 40, 50], info: { title: `Invoice ${d.invoiceNo}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 10 },
    };
  },
};
