// Owner: Agent F. Generic tabular report (finance reports, class lists, defaulters). Consumers: B, C.
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import { BASE_STYLES, formatDate, keyValues, money, SchoolHeaderSchema, schoolHeader, standardFooter, type DocTemplate } from './common';

const Value = z.union([z.string(), z.number(), z.null()]);

export const TableReportDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  title: z.string().min(1),
  subtitle: z.string().nullish(),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  /** Filters shown above the table, e.g. [{label:'Term', value:'Term 1'}]. */
  filters: z.array(z.strictObject({ label: z.string(), value: z.string() })).default([]),
  columns: z.array(z.strictObject({
    key: z.string().min(1),
    label: z.string(),
    /** money = integer pesewas formatted as GHS; date = YYYY-MM-DD. */
    format: z.enum(['text', 'money', 'number', 'date']).default('text'),
    align: z.enum(['left', 'right', 'center']).nullish(),
    width: z.union([z.number().positive(), z.literal('*'), z.literal('auto')]).nullish(),
  })).min(1),
  rows: z.array(z.record(z.string(), Value)),
  totals: z.record(z.string(), Value).nullish(),
  generatedBy: z.string().nullish(),
});
export type TableReportData = z.input<typeof TableReportDataSchema>;
type Parsed = z.output<typeof TableReportDataSchema>;
type Column = Parsed['columns'][number];

function cell(col: Column, v: string | number | null | undefined, bold = false): TableCell {
  let text = '';
  if (v !== null && v !== undefined) {
    if (col.format === 'money' && typeof v === 'number') text = money(v);
    else if (col.format === 'date' && typeof v === 'string') text = formatDate(v);
    else if (col.format === 'number' && typeof v === 'number') text = v.toLocaleString('en-GB');
    else text = String(v);
  }
  const alignment = col.align ?? (col.format === 'money' || col.format === 'number' ? 'right' : 'left');
  return { text, alignment, bold };
}

export const tableReportTemplate: DocTemplate<Parsed> = {
  schema: TableReportDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const body: TableCell[][] = [
      d.columns.map((c) => ({ text: c.label, style: 'tableHeader', alignment: c.align ?? (c.format === 'money' || c.format === 'number' ? 'right' : 'left') })),
      ...d.rows.map((r) => d.columns.map((c) => cell(c, r[c.key]))),
    ];
    if (d.totals) body.push(d.columns.map((c, i) => (i === 0 && d.totals![c.key] === undefined ? { text: 'TOTAL', bold: true } : cell(c, d.totals![c.key], true))));
    const content: Content[] = [...schoolHeader(ctx.school, d.title)];
    if (d.subtitle) content.push({ text: d.subtitle, alignment: 'center', margin: [0, -4, 0, 6] });
    if (d.filters.length) content.push(keyValues(d.filters.map((f) => [f.label, f.value] as [string, string]), { fontSize: 9 }));
    content.push(
      { table: { headerRows: 1, widths: d.columns.map((c) => c.width ?? '*'), body }, layout: 'lightHorizontalLines', fontSize: 8.5 },
      { text: `${d.rows.length} row${d.rows.length === 1 ? '' : 's'}${d.generatedBy ? `  |  Prepared by ${d.generatedBy}` : ''}`, style: 'small', margin: [0, 6, 0, 0] },
    );
    return {
      pageSize: 'A4', pageOrientation: d.orientation, pageMargins: [36, 36, 36, 50], info: { title: d.title },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 9 },
    };
  },
};
