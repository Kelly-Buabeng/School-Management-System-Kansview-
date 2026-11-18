// Owner: Agent F. Test helper: extract text from a PDF buffer (per page) with pdfjs-dist.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfPages(buf: Buffer): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' '));
  }
  await doc.destroy();
  return pages;
}

export async function pdfText(buf: Buffer): Promise<string> {
  return (await pdfPages(buf)).join('\n');
}
