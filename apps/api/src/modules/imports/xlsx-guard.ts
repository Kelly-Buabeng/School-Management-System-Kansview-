// Owner: Agent G. Zip-bomb guard for import workbooks, run BEFORE ExcelJS opens the file (CP5-03).
import { inflateRawSync } from 'node:zlib';
import { AppError } from '../../common/app-error';
import { checkXlsx } from '../../security/file-sniffer';

/**
 * An import holds at most 2,000 rows; a real workbook of that size is a few MB of XML. ExcelJS keeps the whole
 * workbook in memory (several times the XML size), so anything far above this would endanger the API's 1 GB limit.
 */
export const IMPORT_XLSX_LIMITS = {
  /** Real (inflated) size of all parts together. */
  maxTotalUncompressed: 25 * 1024 * 1024,
  /** Parts in the archive (a normal workbook has 10–30). */
  maxEntries: 500,
};

const tooBig = () =>
  new AppError(422, 'IMPORT_FILE_UNREADABLE', 'This Excel file is too large to open safely',
    `Import workbooks can hold up to ${IMPORT_XLSX_LIMITS.maxTotalUncompressed / 1024 / 1024} MB of data once unpacked. Save only the sheet you need as a new .xlsx (or as CSV) and upload that.`);
const unsafe = (why: string) =>
  new AppError(422, 'IMPORT_FILE_UNREADABLE', 'This Excel file was not accepted',
    `It is damaged or contains something an import file should not (${why}). Save it again as a normal .xlsx workbook and retry.`);

interface CentralEntry { name: string; flags: number; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }

function centralDirectory(buf: Buffer): CentralEntry[] | null {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: CentralEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(off + 28);
    out.push({
      name: buf.subarray(off + 46, off + 46 + nameLen).toString('utf8'),
      flags: buf.readUInt16LE(off + 8),
      method: buf.readUInt16LE(off + 10),
      compressedSize: buf.readUInt32LE(off + 20),
      uncompressedSize: buf.readUInt32LE(off + 24),
      localOffset: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return out;
}

/**
 * Throws a 422 problem when the workbook could exhaust memory when opened. Works from the zip central directory
 * and then inflates each part with a hard output cap, so the sizes written in the file cannot lie: memory used
 * here never exceeds the remaining budget, whatever the file claims.
 */
export function assertSafeImportXlsx(buf: Buffer): void {
  const declared = checkXlsx(buf);
  if (declared) {
    if (/ratio|too large|too many/.test(declared)) throw tooBig();
    throw unsafe(declared);
  }
  const entries = centralDirectory(buf);
  if (!entries) throw unsafe('malformed zip');
  if (entries.length > IMPORT_XLSX_LIMITS.maxEntries) throw tooBig();
  let declaredTotal = 0;
  for (const e of entries) declaredTotal += e.uncompressedSize;
  if (declaredTotal > IMPORT_XLSX_LIMITS.maxTotalUncompressed) throw tooBig();

  let budget = IMPORT_XLSX_LIMITS.maxTotalUncompressed;
  for (const e of entries) {
    if (e.flags & 0x1) throw unsafe('password-protected parts');
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw unsafe('malformed zip');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (start + e.compressedSize > buf.length) throw unsafe('malformed zip');
    const data = buf.subarray(start, start + e.compressedSize);
    let actual: number;
    if (e.method === 0) actual = data.length;
    else if (e.method === 8) {
      try {
        actual = inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length;
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw tooBig();
        throw unsafe('damaged compressed data');
      }
    } else throw unsafe(`unsupported compression method ${e.method}`);
    if (actual !== e.uncompressedSize) throw unsafe('part sizes do not match the archive directory');
    budget -= actual;
    if (budget < 0) throw tooBig();
  }
}
