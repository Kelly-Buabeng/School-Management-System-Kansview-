// Owner: Agent F. Data Protection Act subject access pack (all data held about a person). Consumer: Agent D.
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import { BASE_STYLES, IsoDateSchema, keyValues, SchoolHeaderSchema, schoolHeader, standardFooter, formatDate, type DocTemplate } from './common';

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const SubjectAccessPackDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  requestRef: z.string().min(1),
  requestDate: IsoDateSchema.nullish(),
  subject: z.strictObject({ name: z.string().min(1), code: z.string().nullish(), relationship: z.string().nullish() }),
  sections: z.array(z.strictObject({
    title: z.string().min(1),
    note: z.string().nullish(),
    fields: z.array(z.strictObject({ label: z.string(), value: Cell })).nullish(),
    table: z.strictObject({ columns: z.array(z.string()).min(1), rows: z.array(z.array(Cell)) }).nullish(),
  })),
});
export type SubjectAccessPackData = z.input<typeof SubjectAccessPackDataSchema>;
type Parsed = z.output<typeof SubjectAccessPackDataSchema>;

const str = (v: string | number | boolean | null): string => (v === null ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

export const subjectAccessPackTemplate: DocTemplate<Parsed> = {
  schema: SubjectAccessPackDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'PERSONAL DATA HELD BY THE SCHOOL'),
      keyValues([['Request', d.requestRef], ['Received', formatDate(d.requestDate)], ['Data subject', d.subject.name], ['ID', d.subject.code], ['Relationship', d.subject.relationship]]),
      { text: 'This pack lists the personal data the school holds, as required by the Data Protection Act, 2012 (Act 843).', fontSize: 9, italics: true, margin: [0, 0, 0, 8] },
    ];
    for (const s of d.sections) {
      content.push({ text: s.title, bold: true, fontSize: 12, margin: [0, 10, 0, 4] });
      if (s.note) content.push({ text: s.note, fontSize: 9, margin: [0, 0, 0, 4] });
      if (s.fields?.length) content.push(keyValues(s.fields.map((f) => [f.label, str(f.value)] as [string, string]), { fontSize: 9 }));
      if (s.table) {
        const body: TableCell[][] = [
          s.table.columns.map((c) => ({ text: c, style: 'tableHeader' })),
          ...s.table.rows.map((r) => s.table!.columns.map((_, i) => str(r[i] ?? null))),
        ];
        content.push({ table: { headerRows: 1, widths: s.table.columns.map(() => '*'), body }, layout: 'lightHorizontalLines', fontSize: 8 });
      }
      if (!s.fields?.length && !s.table?.rows.length) content.push({ text: 'No records.', fontSize: 9, italics: true });
    }
    return {
      pageSize: 'A4', pageMargins: [40, 40, 40, 50], info: { title: `Subject access pack ${d.requestRef}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 10 },
    };
  },
};
