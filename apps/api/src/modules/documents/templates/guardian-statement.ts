// Owner: Agent F. One statement for a guardian covering all their children. Consumer: Agent C.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  balanceSentence, BASE_STYLES, keyValues, money, PesewasSchema, SchoolHeaderSchema, schoolHeader, standardFooter,
  StatementLineSchema, statementTable, StudentRefSchema, type DocTemplate,
} from './common';

export const GuardianStatementDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  guardian: z.strictObject({ fullName: z.string().min(1), phone: z.string().nullish(), address: z.string().nullish() }),
  periodLabel: z.string().min(1),
  students: z.array(z.strictObject({
    student: StudentRefSchema,
    openingBalancePesewas: PesewasSchema,
    lines: z.array(StatementLineSchema),
    closingBalancePesewas: PesewasSchema,
  })).min(1),
  totalBalancePesewas: PesewasSchema,
});
export type GuardianStatementData = z.input<typeof GuardianStatementDataSchema>;
type Parsed = z.output<typeof GuardianStatementDataSchema>;

export const guardianStatementTemplate: DocTemplate<Parsed> = {
  schema: GuardianStatementDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'FAMILY FEE STATEMENT'),
      keyValues([['Guardian', d.guardian.fullName], ['Phone', d.guardian.phone], ['Address', d.guardian.address], ['Period', d.periodLabel]]),
    ];
    for (const s of d.students) {
      content.push(
        { text: `${s.student.fullName} (${s.student.code})${s.student.className ? `, ${s.student.className}` : ''}`, bold: true, margin: [0, 8, 0, 4] },
        statementTable(s.openingBalancePesewas, s.lines, s.closingBalancePesewas),
      );
    }
    content.push(
      { columns: [{ text: 'TOTAL FOR FAMILY', bold: true }, { text: money(d.totalBalancePesewas), bold: true, alignment: 'right' }], margin: [0, 12, 0, 0] },
      { text: balanceSentence(d.totalBalancePesewas), margin: [0, 4, 0, 0] },
    );
    return {
      pageSize: 'A4', pageMargins: [40, 40, 40, 50], info: { title: `Family statement ${d.guardian.fullName}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 10 },
    };
  },
};
