// Owner: Agent F. All report cards for a class in one PDF, one student per page. Consumer: Agent B.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import { BASE_STYLES, SchoolHeaderSchema, standardFooter, type DocTemplate } from './common';
import { reportCardContent, ReportCardSchema } from './report-card';

export const ClassReportCardsDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  className: z.string().min(1),
  termName: z.string().min(1),
  cards: z.array(ReportCardSchema).min(1),
});
export type ClassReportCardsData = z.input<typeof ClassReportCardsDataSchema>;
type Parsed = z.output<typeof ClassReportCardsDataSchema>;

export const classReportCardsTemplate: DocTemplate<Parsed> = {
  schema: ClassReportCardsDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const content: Content[] = d.cards.map((card, i): Content => ({
      stack: reportCardContent(card, ctx),
      ...(i > 0 ? { pageBreak: 'before' as const } : {}),
    }));
    return {
      pageSize: 'A4', pageMargins: [40, 36, 40, 50], info: { title: `Report cards ${d.className} ${d.termName}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 10 },
    };
  },
};
