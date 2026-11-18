// Owner: Agent F. Terminal report card. Consumer: Agent B (academics).
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  BASE_STYLES, formatDate, formatPosition, IsoDateSchema, keyValues, ordinal, SchoolHeaderSchema, schoolHeader, standardFooter,
  type BuildContext, type DocTemplate,
} from './common';

const Score = z.number().min(0).max(1000);

export const ReportCardSchema = z.strictObject({
  student: z.strictObject({
    code: z.string().min(1),
    fullName: z.string().min(1),
    className: z.string().min(1),
    gender: z.string().nullish(),
    dateOfBirth: IsoDateSchema.nullish(),
  }),
  academicYear: z.string().min(1),
  termName: z.string().min(1),
  subjects: z.array(z.strictObject({
    subject: z.string().min(1),
    classScore: Score.nullish(),
    examScore: Score.nullish(),
    totalScore: Score.nullish(),
    grade: z.string().nullish(),
    remark: z.string().nullish(),
    /** Position in the subject, e.g. 2 → '2nd'. */
    position: z.number().int().positive().nullish(),
  })),
  /** Weights printed in the column headers, e.g. 30/70. */
  classScoreWeight: z.number().nullish(),
  examScoreWeight: z.number().nullish(),
  totalScore: Score.nullish(),
  averageScore: Score.nullish(),
  overallGrade: z.string().nullish(),
  /** Overall class position: { rank: 3, of: 34 } prints '3rd of 34'. */
  position: z.strictObject({ rank: z.number().int().positive(), of: z.number().int().positive() }).nullish(),
  attendance: z.strictObject({ present: z.number().int().min(0), total: z.number().int().min(0) }).nullish(),
  conduct: z.string().nullish(),
  interest: z.string().nullish(),
  classTeacherRemark: z.string().nullish(),
  headteacherRemark: z.string().nullish(),
  classTeacherName: z.string().nullish(),
  headteacherName: z.string().nullish(),
  promotedTo: z.string().nullish(),
  nextTermBegins: IsoDateSchema.nullish(),
});
export type ReportCard = z.input<typeof ReportCardSchema>;
type ParsedCard = z.output<typeof ReportCardSchema>;

export const ReportCardDataSchema = ReportCardSchema.extend({ school: SchoolHeaderSchema.nullish() });
export type ReportCardData = z.input<typeof ReportCardDataSchema>;
type Parsed = z.output<typeof ReportCardDataSchema>;

const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '' : Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Content for one report card (also used by class_report_cards, one card per page). */
export function reportCardContent(c: ParsedCard, ctx: BuildContext): Content[] {
  const cw = c.classScoreWeight ? ` (${c.classScoreWeight}%)` : '';
  const ew = c.examScoreWeight ? ` (${c.examScoreWeight}%)` : '';
  const header: TableCell[] = ['Subject', `Class score${cw}`, `Exam score${ew}`, 'Total', 'Grade', 'Position', 'Remark']
    .map((t) => ({ text: t, style: 'tableHeader', fontSize: 8.5 }));
  const rows: TableCell[][] = c.subjects.map((s): TableCell[] => [
    s.subject,
    { text: fmt(s.classScore), alignment: 'center' },
    { text: fmt(s.examScore), alignment: 'center' },
    { text: fmt(s.totalScore), alignment: 'center', bold: true },
    { text: s.grade ?? '', alignment: 'center' },
    { text: s.position ? ordinal(s.position) : '', alignment: 'center' },
    s.remark ?? '',
  ]);
  if (c.totalScore !== null && c.totalScore !== undefined) {
    rows.push([{ text: 'TOTAL', bold: true }, '', '', { text: fmt(c.totalScore), alignment: 'center', bold: true }, { text: c.overallGrade ?? '', alignment: 'center', bold: true }, '', '']);
  }
  const content: Content[] = [
    ...schoolHeader(ctx.school, 'TERMINAL REPORT'),
    {
      columns: [
        keyValues([['Name', c.student.fullName], ['Student ID', c.student.code], ['Class', c.student.className], ['Gender', c.student.gender]]),
        keyValues([
          ['Academic year', c.academicYear], ['Term', c.termName],
          ['Position in class', c.position ? formatPosition(c.position.rank, c.position.of) : null],
          ['Attendance', c.attendance ? `${c.attendance.present} out of ${c.attendance.total} days` : null],
        ]),
      ],
    },
    { table: { headerRows: 1, widths: ['*', 52, 52, 40, 36, 44, 90], body: [header, ...rows] }, layout: 'lightHorizontalLines', fontSize: 9, margin: [0, 4, 0, 8] },
    keyValues([
      ['Average score', fmt(c.averageScore)],
      ['Overall grade', c.overallGrade],
      ['Conduct', c.conduct],
      ['Interest', c.interest],
      ["Class teacher's remarks", c.classTeacherRemark],
      ["Headteacher's remarks", c.headteacherRemark],
      ['Promoted to', c.promotedTo],
      ['Next term begins', c.nextTermBegins ? formatDate(c.nextTermBegins) : null],
    ]),
    {
      columns: [
        { stack: [{ text: '\n\n_________________________' }, { text: c.classTeacherName ?? 'Class teacher', fontSize: 9 }, { text: 'Class teacher', fontSize: 8 }] },
        { stack: [{ text: '\n\n_________________________' }, { text: c.headteacherName ?? 'Headteacher', fontSize: 9 }, { text: 'Headteacher', fontSize: 8 }], alignment: 'right' },
      ],
      margin: [0, 10, 0, 0],
    },
  ];
  return content;
}

export const reportCardTemplate: DocTemplate<Parsed> = {
  schema: ReportCardDataSchema,
  build(d, ctx): TDocumentDefinitions {
    return {
      pageSize: 'A4', pageMargins: [40, 36, 40, 50], info: { title: `Report card ${d.student.code} ${d.termName}` },
      footer: standardFooter(ctx.generatedAt), content: reportCardContent(d, ctx), styles: BASE_STYLES, defaultStyle: { fontSize: 10 },
    };
  },
};
