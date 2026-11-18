// Owner: Agent F. Shared building blocks for PDF templates.
import { formatCedis, SCHOOL_TIMEZONE, type Pesewas } from '@sms/shared';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import { z } from 'zod';

/** School profile printed at the top of every document. PdfService fills it from settings when omitted. */
export const SchoolHeaderSchema = z.strictObject({
  name: z.string().min(1),
  motto: z.string().nullish(),
  address: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  /** data:image/png;base64,... or data:image/jpeg;base64,... */
  logoDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).nullish(),
});
export type SchoolHeader = z.infer<typeof SchoolHeaderSchema>;

export const PesewasSchema = z.number().int().refine(Number.isSafeInteger, 'amount out of range');
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoDateTimeSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date-time');

export const StudentRefSchema = z.strictObject({
  code: z.string().min(1),
  fullName: z.string().min(1),
  className: z.string().nullish(),
});
export type StudentRef = z.infer<typeof StudentRefSchema>;

export const SignatorySchema = z.strictObject({ name: z.string().min(1), title: z.string().min(1) });
export type Signatory = z.infer<typeof SignatorySchema>;

export interface BuildContext {
  school: SchoolHeader | null;
  generatedAt: Date;
}

export interface DocTemplate<T> {
  schema: z.ZodType<T>;
  build(data: T, ctx: BuildContext): TDocumentDefinitions;
}

/**
 * Money for PDFs. The bundled Roboto font has no cedi sign (₵), so documents print the ISO code: "GHS 1,250.50".
 * The digits come from formatCedis so screens and paper always agree.
 */
export function money(pesewas: Pesewas | null | undefined): string {
  if (pesewas === null || pesewas === undefined) return '';
  return `GHS ${formatCedis(pesewas, { symbol: false })}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-17' → '17 Nov 2026' (no timezone shifting for calendar dates). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Instant → '17 Nov 2026, 14:05' in Africa/Accra. */
export function formatDateTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHOOL_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
}

/** 1 → '1st', 22 → '22nd', 13 → '13th'. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Class position as printed on report cards: '3rd of 34'. */
export function formatPosition(rank: number, of: number): string {
  return `${ordinal(rank)} of ${of}`;
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function wordsBelowThousand(n: number): string {
  const out: string[] = [];
  if (n >= 100) {
    out.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
    if (n) out.push('and');
  }
  if (n >= 20) out.push(TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : ''));
  else if (n > 0) out.push(ONES[n]!);
  return out.join(' ');
}

function integerWords(n: number): string {
  if (n === 0) return 'zero';
  const scales: Array<[number, string]> = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1000, 'thousand']];
  const out: string[] = [];
  for (const [value, name] of scales) {
    if (n >= value) {
      out.push(`${wordsBelowThousand(Math.floor(n / value))} ${name}`);
      n %= value;
    }
  }
  if (n) out.push(n < 100 && out.length ? `and ${wordsBelowThousand(n)}` : wordsBelowThousand(n));
  return out.join(' ');
}

/** 125050 → 'One thousand two hundred and fifty Ghana cedis and fifty pesewas'. */
export function amountInWords(pesewas: Pesewas): string {
  const abs = Math.abs(pesewas);
  const cedis = Math.floor(abs / 100);
  const pes = abs % 100;
  let s = `${integerWords(cedis)} Ghana cedi${cedis === 1 ? '' : 's'}`;
  if (pes) s += ` and ${integerWords(pes)} pesewa${pes === 1 ? '' : 's'}`;
  if (pesewas < 0) s = `minus ${s}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Logo + school name, motto and contact lines, then the document title. */
export function schoolHeader(school: SchoolHeader | null, title: string, opts: { compact?: boolean } = {}): Content[] {
  const lines: Content[] = [];
  if (school) {
    const contact = [school.address, school.phone, school.email].filter(Boolean).join('  |  ');
    const text: Content[] = [
      { text: school.name.toUpperCase(), style: 'schoolName', alignment: opts.compact ? 'center' : 'left' },
    ];
    if (school.motto) text.push({ text: school.motto, italics: true, fontSize: opts.compact ? 7 : 9, alignment: opts.compact ? 'center' : 'left' });
    if (contact) text.push({ text: contact, fontSize: opts.compact ? 7 : 8, color: '#444444', alignment: opts.compact ? 'center' : 'left' });
    if (school.logoDataUrl && !opts.compact) {
      lines.push({ columns: [{ image: school.logoDataUrl, fit: [56, 56], width: 64 }, { stack: text, width: '*' }], columnGap: 8 });
    } else {
      if (school.logoDataUrl) lines.push({ image: school.logoDataUrl, fit: [40, 40], alignment: 'center' });
      lines.push({ stack: text });
    }
    lines.push({ canvas: [{ type: 'line', x1: 0, y1: 4, x2: opts.compact ? 200 : 515, y2: 4, lineWidth: 0.8, lineColor: '#888888' }], margin: [0, 2, 0, 6] });
  }
  lines.push({ text: title, style: 'docTitle', alignment: 'center', margin: [0, 2, 0, 8] });
  return lines;
}

/** Two-column label/value block (e.g. student details). */
export function keyValues(pairs: Array<[string, string | number | null | undefined]>, opts: { fontSize?: number } = {}): Content {
  const body: TableCell[][] = pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [{ text: k, bold: true, fontSize: opts.fontSize }, { text: String(v), fontSize: opts.fontSize }]);
  if (body.length === 0) return { text: '' };
  return { table: { widths: ['auto', '*'], body }, layout: 'noBorders', margin: [0, 0, 0, 6] };
}

export function signatureBlock(s: Signatory): Content {
  return {
    stack: [
      { text: '\n\n______________________________' },
      { text: s.name, bold: true },
      { text: s.title, fontSize: 9 },
    ],
    margin: [0, 16, 0, 0],
  };
}

export const BASE_STYLES: TDocumentDefinitions['styles'] = {
  schoolName: { fontSize: 14, bold: true },
  docTitle: { fontSize: 13, bold: true },
  tableHeader: { bold: true, fillColor: '#eeeeee' },
  small: { fontSize: 8, color: '#444444' },
  total: { bold: true },
};

export function standardFooter(generatedAt: Date): TDocumentDefinitions['footer'] {
  return (currentPage: number, pageCount: number) => ({
    columns: [
      { text: `Printed ${formatDateTime(generatedAt)}`, style: 'small' },
      { text: `Page ${currentPage} of ${pageCount}`, style: 'small', alignment: 'right' },
    ],
    margin: [40, 10, 40, 0],
  });
}

/** Ledger-style table: date, description, reference, debit, credit, balance. */
export const StatementLineSchema = z.strictObject({
  date: IsoDateSchema,
  description: z.string(),
  reference: z.string().nullish(),
  debitPesewas: PesewasSchema.nullish(),
  creditPesewas: PesewasSchema.nullish(),
  balancePesewas: PesewasSchema,
});
export type StatementLine = z.infer<typeof StatementLineSchema>;

export function statementTable(openingPesewas: Pesewas, lines: StatementLine[], closingPesewas: Pesewas): Content {
  const body: TableCell[][] = [
    ['Date', 'Description', 'Ref', 'Charged', 'Paid', 'Balance'].map((t) => ({ text: t, style: 'tableHeader' })),
    [{ text: '' }, { text: 'Opening balance', italics: true }, '', '', '', { text: money(openingPesewas), alignment: 'right' }],
    ...lines.map((l): TableCell[] => [
      formatDate(l.date), l.description, l.reference ?? '',
      { text: money(l.debitPesewas), alignment: 'right' },
      { text: money(l.creditPesewas), alignment: 'right' },
      { text: money(l.balancePesewas), alignment: 'right' },
    ]),
    [{ text: '' }, { text: 'Closing balance', bold: true }, '', '', '', { text: money(closingPesewas), alignment: 'right', bold: true }],
  ];
  return { table: { headerRows: 1, widths: [58, '*', 50, 62, 62, 66], body }, layout: 'lightHorizontalLines', fontSize: 8.5 };
}

export function balanceSentence(balancePesewas: Pesewas): string {
  if (balancePesewas > 0) return `Amount owed to the school: ${money(balancePesewas)}`;
  if (balancePesewas < 0) return `Credit in favour of the family: ${money(-balancePesewas)}`;
  return 'No balance outstanding. Thank you.';
}
