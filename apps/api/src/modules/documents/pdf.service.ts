// Owner: Agent F.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';
import { AppError } from '../../common/app-error';
import type { PdfDocType, PdfService } from '../../common/contracts';
import { KYSELY, type Db } from '../../common/db/database.module';
import { CONSUMER_ADAPTERS } from './consumer-adapters';
import { SCHOOL_HEADER_SOURCE, type SchoolHeaderSource } from './school-header.source';
import { BASE_STYLES, PDF_TEMPLATES, type PdfDataByType } from './templates';

type Watermark = 'COPY' | 'REVERSED' | 'DRAFT';

let cachedFonts: TFontDictionary | null = null;

/** Roboto from the pdfmake virtual file system, bundled in node_modules: no network, no system fonts needed. */
function bundledFonts(): TFontDictionary {
  if (cachedFonts) return cachedFonts;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vfs = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;
  const buf = (name: string): Buffer => {
    const b64 = vfs[name];
    if (!b64) throw new Error(`Bundled font ${name} is missing from pdfmake`);
    return Buffer.from(b64, 'base64');
  };
  // pdfmake's typings say string, but the node printer accepts Buffers.
  cachedFonts = {
    Roboto: {
      normal: buf('Roboto-Regular.ttf'),
      bold: buf('Roboto-Medium.ttf'),
      italics: buf('Roboto-Italic.ttf'),
      bolditalics: buf('Roboto-MediumItalic.ttf'),
    },
  } as unknown as TFontDictionary;
  return cachedFonts;
}

const WATERMARK_COLOR: Record<Watermark, string> = { COPY: '#555555', REVERSED: '#b00020', DRAFT: '#1f4e9c' };

@Injectable()
export class PdfmakePdfService implements PdfService {
  private readonly logger = new Logger('PdfService');
  private readonly printer = new PdfPrinter(bundledFonts());

  constructor(
    @Inject(SCHOOL_HEADER_SOURCE) private readonly schoolSource: SchoolHeaderSource,
    @Optional() @Inject(KYSELY) private readonly db?: Db,
  ) {}

  /** Typed convenience wrapper: `renderTyped('receipt', data)` checks the data shape at compile time. */
  renderTyped<K extends PdfDocType>(docType: K, data: PdfDataByType[K], opts?: { watermark?: Watermark }): Promise<Buffer> {
    return this.render(docType, data as unknown as Record<string, unknown>, opts);
  }

  async render(docType: PdfDocType, data: Record<string, unknown>, opts: { watermark?: Watermark } = {}): Promise<Buffer> {
    const template = PDF_TEMPLATES[docType];
    if (!template) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown document type', docType);
    let parsed = template.schema.safeParse(data);
    if (!parsed.success) {
      // Older consumer shapes (see consumer-adapters.ts) are translated, then validated against the typed shape.
      const adapter = CONSUMER_ADAPTERS[docType];
      const adapted = adapter && this.db ? await adapter(data, this.db) : null;
      if (adapted) parsed = template.schema.safeParse(adapted);
    }
    if (!parsed.success) {
      // A consumer passed the wrong shape: a programming error, not a user error. Log details, keep the message plain.
      this.logger.error({ docType, issues: parsed.error.issues }, 'invalid PDF data');
      throw new AppError(500, 'INTERNAL_ERROR', 'The document could not be created', `Invalid data for ${docType}`, undefined, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const value = parsed.data as { school?: unknown; reversal?: unknown };
    const school = (value.school as never) ?? (await this.schoolSource.get());
    const generatedAt = new Date();
    const def: TDocumentDefinitions = template.build(parsed.data, { school, generatedAt });

    const watermark: Watermark | undefined = opts.watermark ?? (docType === 'receipt' && value.reversal ? 'REVERSED' : undefined);
    if (watermark) def.watermark = { text: watermark, color: WATERMARK_COLOR[watermark], opacity: 0.18, bold: true };
    def.defaultStyle = { font: 'Roboto', ...def.defaultStyle };
    def.styles = { ...BASE_STYLES, ...def.styles };
    def.info = { creator: 'Kansview School Management System', producer: 'Kansview SMS', ...def.info };
    def.compress = true;

    return this.toBuffer(def);
  }

  private toBuffer(def: TDocumentDefinitions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = this.printer.createPdfKitDocument(def);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }
}
