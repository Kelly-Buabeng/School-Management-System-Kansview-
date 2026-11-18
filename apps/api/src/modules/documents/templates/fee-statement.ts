// Owner: Agent F. Per-student fee statement. Consumer: Agent C.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  balanceSentence, BASE_STYLES, formatDate, IsoDateSchema, keyValues, PesewasSchema, SchoolHeaderSchema, schoolHeader,
  standardFooter, StatementLineSchema, statementTable, StudentRefSchema, type DocTemplate,
} from './common';

export const FeeStatementDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  student: StudentRefSchema,
  /** e.g. '2026/2027 Term 1' or 'All terms'. */
  periodLabel: z.string().min(1),
  fromDate: IsoDateSchema.nullish(),
  toDate: IsoDateSchema.nullish(),
  openingBalancePesewas: PesewasSchema,
  lines: z.array(StatementLineSchema),
  closingBalancePesewas: PesewasSchema,
  notes: z.string().nullish(),
});
export type FeeStatementData = z.input<typeof FeeStatementDataSchema>;
type Parsed = z.output<typeof FeeStatementDataSchema>;

export const feeStatementTemplate: DocTemplate<Parsed> = {
  schema: FeeStatementDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'FEE STATEMENT'),
      keyValues([
        ['Student', d.student.fullName], ['Student ID', d.student.code], ['Class', d.student.className], ['Period', d.periodLabel],
        ['Dates', d.fromDate || d.toDate ? `${formatDate(d.fromDate)} to ${formatDate(d.toDate)}` : null],
      ]),
      statementTable(d.openingBalancePesewas, d.lines, d.closingBalancePesewas),
      { text: balanceSentence(d.closingBalancePesewas), bold: true, margin: [0, 10, 0, 0] },
    ];
    if (d.notes) content.push({ text: d.notes, fontSize: 9, margin: [0, 6, 0, 0] });
    return {
      pageSize: 'A4', pageMargins: [40, 40, 40, 50], info: { title: `Fee statement ${d.student.code}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 10 },
    };
  },
};
