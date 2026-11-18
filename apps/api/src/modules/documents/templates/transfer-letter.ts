// Owner: Agent F. Transfer / leaving letter. Consumer: Agent B (withdrawals).
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { z } from 'zod';
import {
  BASE_STYLES, formatDate, IsoDateSchema, keyValues, SchoolHeaderSchema, schoolHeader, signatureBlock, SignatorySchema,
  standardFooter, type DocTemplate,
} from './common';

export const TransferLetterDataSchema = z.strictObject({
  school: SchoolHeaderSchema.nullish(),
  letterNo: z.string().min(1),
  date: IsoDateSchema,
  student: z.strictObject({
    code: z.string().min(1),
    fullName: z.string().min(1),
    dateOfBirth: IsoDateSchema.nullish(),
    gender: z.string().nullish(),
    admissionDate: IsoDateSchema.nullish(),
    lastClass: z.string().nullish(),
  }),
  destinationSchool: z.string().nullish(),
  reason: z.string().nullish(),
  lastAttendanceDate: IsoDateSchema.nullish(),
  conduct: z.string().nullish(),
  feesCleared: z.boolean(),
  /** Optional custom paragraph replacing the standard wording. */
  body: z.string().nullish(),
  signatory: SignatorySchema,
});
export type TransferLetterData = z.input<typeof TransferLetterDataSchema>;
type Parsed = z.output<typeof TransferLetterDataSchema>;

export const transferLetterTemplate: DocTemplate<Parsed> = {
  schema: TransferLetterDataSchema,
  build(d, ctx): TDocumentDefinitions {
    const schoolName = ctx.school?.name ?? 'this school';
    const body = d.body ?? `This is to certify that ${d.student.fullName} (Student ID ${d.student.code}) was a student of ${schoolName}`
      + `${d.student.admissionDate ? ` from ${formatDate(d.student.admissionDate)}` : ''}`
      + `${d.lastAttendanceDate ? ` until ${formatDate(d.lastAttendanceDate)}` : ''}`
      + `${d.student.lastClass ? `, last in ${d.student.lastClass}` : ''}.`
      + `${d.destinationSchool ? ` The student is transferring to ${d.destinationSchool}.` : ''}`
      + ' We wish the student every success.';
    const content: Content[] = [
      ...schoolHeader(ctx.school, 'TRANSFER LETTER'),
      { columns: [{ text: `Ref: ${d.letterNo}` }, { text: formatDate(d.date), alignment: 'right' }], margin: [0, 0, 0, 10] },
      { text: 'TO WHOM IT MAY CONCERN', bold: true, margin: [0, 0, 0, 10] },
      { text: body, lineHeight: 1.3, margin: [0, 0, 0, 10] },
      keyValues([
        ['Date of birth', formatDate(d.student.dateOfBirth)],
        ['Gender', d.student.gender],
        ['Reason for leaving', d.reason],
        ['Conduct', d.conduct],
        ['Fees', d.feesCleared ? 'All fees cleared' : 'Fees NOT fully cleared'],
      ]),
      signatureBlock(d.signatory),
    ];
    return {
      pageSize: 'A4', pageMargins: [50, 40, 50, 50], info: { title: `Transfer letter ${d.letterNo}` },
      footer: standardFooter(ctx.generatedAt), content, styles: BASE_STYLES, defaultStyle: { fontSize: 11 },
    };
  },
};
