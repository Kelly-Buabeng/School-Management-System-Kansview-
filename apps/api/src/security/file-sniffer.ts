import { inflateSync } from 'node:zlib';

/**
 * Content-based file type detection and structural sanity checks for uploads.
 * The client's file name and Content-Type are never trusted.
 */
export type SniffedType =
  | 'image/jpeg'
  | 'image/png'
  | 'application/pdf'
  | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface SniffResult {
  type: SniffedType | null;
  /** Why the file was refused (for logs; users get a generic plain-English message). */
  reason?: string;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function startsWith(buf: Buffer, sig: Buffer | number[], offset = 0): boolean {
  const s = Buffer.isBuffer(sig) ? sig : Buffer.from(sig);
  return buf.length >= offset + s.length && buf.subarray(offset, offset + s.length).equals(s);
}

/** Markup that must never be accepted (stored XSS through SVG/HTML, or a browser sniffing it as HTML). */
const MARKUP = /<\s*(?:!doctype|html|head|body|script|svg|iframe|object|embed|\?xml|\?php|meta|link|style|img|a\s)/i;

function looksLikeMarkup(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  return head.startsWith('<') || MARKUP.test(head);
}

export function sniff(buf: Buffer): SniffResult {
  if (buf.length === 0) return { type: null, reason: 'empty file' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg' };
  if (startsWith(buf, PNG_SIG)) return { type: 'image/png' };
  if (startsWith(buf, Buffer.from('%PDF-'))) return { type: 'application/pdf' };
  if (startsWith(buf, ZIP_SIG)) {
    return isXlsx(buf) ? { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } : { type: null, reason: 'zip archive that is not an xlsx workbook' };
  }
  if (looksLikeMarkup(buf)) return { type: null, reason: 'markup (html/svg/xml) content' };
  if (isPlainText(buf)) return { type: 'text/csv' };
  return { type: null, reason: 'unrecognised binary content' };
}

function isPlainText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\x01-\x08\x0b\x0e-\x1f\x7f]/.test(buf.subarray(0, 65536).toString('utf8'));
}

// ---------------- ZIP / XLSX ----------------

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/** Reads the ZIP central directory (no decompression). Returns null if the archive is malformed. */
export function readZipDirectory(buf: Buffer): ZipEntry[] | null {
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, compressedSize, uncompressedSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function isXlsx(buf: Buffer): boolean {
  const entries = readZipDirectory(buf);
  if (!entries) return false;
  const names = new Set(entries.map((e) => e.name));
  return names.has('[Content_Types].xml') && [...names].some((n) => n.startsWith('xl/'));
}

export const ZIP_LIMITS = { maxEntries: 2000, maxTotalUncompressed: 200 * 1024 * 1024, maxRatio: 100 };

/** Zip-bomb and dangerous-content checks for XLSX workbooks. */
export function checkXlsx(buf: Buffer): string | null {
  const entries = readZipDirectory(buf);
  if (!entries) return 'malformed zip';
  if (entries.length > ZIP_LIMITS.maxEntries) return 'too many entries in workbook';
  let total = 0;
  for (const e of entries) {
    if (e.name.includes('..') || e.name.startsWith('/') || e.name.includes('\\')) return 'unsafe path in workbook';
    if (/vbaProject\.bin$/i.test(e.name) || /\.(exe|dll|js|vbs|bat|cmd|ps1|scr)$/i.test(e.name)) return 'macro or executable inside workbook';
    if (e.uncompressedSize === 0xffffffff || e.compressedSize === 0xffffffff) return 'zip64 entries are not supported';
    total += e.uncompressedSize;
    if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > ZIP_LIMITS.maxRatio && e.uncompressedSize > 1024 * 1024) {
      return 'compression ratio too high (possible zip bomb)';
    }
  }
  if (total > ZIP_LIMITS.maxTotalUncompressed) return 'workbook too large when uncompressed';
  return null;
}

// ---------------- PDF ----------------

/** PDF name objects that can run code, open other programs or carry hidden files. */
const DANGEROUS_PDF_NAMES = ['/javascript', '/js', '/launch', '/embeddedfile', '/embeddedfiles', '/xfa', '/richmedia', '/submitform', '/importdata', '/gotoe'];
const MAX_INFLATED_TOTAL = 64 * 1024 * 1024;

/** Decodes PDF name escapes (`/J#61vaScript` → `/javascript`) and lower-cases. */
function pdfNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/[^\s/<>[\](){}%]+/g)) {
    out.add(m[0].replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase());
  }
  return out;
}

export function checkPdf(buf: Buffer): string | null {
  if (!startsWith(buf, Buffer.from('%PDF-'))) return 'missing PDF header at start of file';
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  const eofAt = tail.lastIndexOf('%%EOF');
  if (eofAt < 0) return 'missing %%EOF marker';
  const trailing = tail.slice(eofAt + 5).trim();
  if (trailing.length > 0) return 'data appended after end of PDF (possible polyglot)';

  const raw = buf.toString('latin1');
  const texts = [raw];
  // Look inside compressed streams too (object streams can hide dictionaries).
  let inflated = 0;
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = raw.lastIndexOf('<<', m.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, m.index) : '';
    if (/\/FlateDecode/.test(dict) && !/\/(Subtype\s*\/Image|DCTDecode)/.test(dict)) {
      try {
        const out = inflateSync(buf.subarray(start, end), { maxOutputLength: 16 * 1024 * 1024 });
        inflated += out.length;
        if (inflated > MAX_INFLATED_TOTAL) return 'compressed content too large (possible decompression bomb)';
        texts.push(out.toString('latin1'));
      } catch {
        // Not every stream inflates cleanly (e.g. predictor quirks); the raw scan still applies.
      }
    }
    streamRe.lastIndex = end;
  }
  for (const t of texts) {
    const names = pdfNames(t);
    const bad = DANGEROUS_PDF_NAMES.find((n) => names.has(n));
    if (bad) return `PDF contains ${bad} (active content is not allowed)`;
  }
  return null;
}

/** Characters stripped from stored original file names (path separators, control and bidi-override characters). */
export function sanitiseFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\x00-\x1f\x7f/\\:*?"<>|‪-‮⁦-⁩]/g, '_').replace(/^\.+/, '_').trim();
  return (cleaned || 'file').slice(0, 200);
}
