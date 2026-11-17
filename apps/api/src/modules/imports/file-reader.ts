import ExcelJS from 'exceljs';
import { AppError } from '../../common/app-error';
import { headerLookup, normaliseHeader, type ImportType } from './import-columns';

/** A raw cell as stored in import.rows.raw: dates already turned into 'YYYY-MM-DD' strings. */
export type RawCell = string | number | boolean | null;

export interface RawRow {
  /** Row number as the user sees it in their spreadsheet (1-based, header row included). */
  rowNumber: number;
  /** Original header text → cell value. */
  cells: Record<string, RawCell>;
}

export interface ParsedFile {
  format: 'xlsx' | 'csv';
  sheetName: string | null;
  /** Original header texts in file order (merged group headers already combined, e.g. "Guardian 1 Phone"). */
  headers: string[];
  /** Original header text → column key (only recognised columns). */
  mapping: Record<string, string>;
  /** Headers that did not match any known column (ignored, shown to the user). */
  unknownHeaders: string[];
  headerRowNumber: number;
  rows: RawRow[];
}

export const MAX_IMPORT_ROWS = 2000;

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SKIP_SHEETS = new Set(['instructions', 'lists', 'readme', 'help', 'notes']);

export function detectFormat(buffer: Buffer, fileName = ''): 'xlsx' | 'csv' {
  if (buffer.subarray(0, 4).equals(XLSX_MAGIC)) return 'xlsx';
  if (/\.xls$/i.test(fileName) || buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'Old Excel (.xls) files cannot be read', 'Open the file in Excel and choose File → Save As → Excel Workbook (.xlsx), then upload it again.');
  }
  return 'csv';
}

// ------------------------------------------------------------------ CSV

/** Decodes UTF-8 (with or without BOM); falls back to Windows-1252 for files saved by older Excel. */
export function decodeText(buffer: Buffer): string {
  let buf = buffer;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  else if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Picks the delimiter that appears most often (outside quotes) in the first non-empty lines. */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const sample = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 5).join('\n');
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]! += 1;
  }
  if (counts[';']! > counts[',']! && counts[';']! >= counts['\t']!) return ';';
  if (counts['\t']! > counts[',']!) return '\t';
  return ',';
}

/** RFC 4180-style CSV parser: quoted fields, "" escapes, newlines inside quotes, CRLF/LF. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------------ XLSX

function isoFromDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function cellToRaw(v: ExcelJS.CellValue): RawCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isoFromDate(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('formula' in v || 'sharedFormula' in v) return cellToRaw((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return null;
  }
  return String(v);
}

async function readXlsxGrid(buffer: Buffer): Promise<{ sheetName: string; grid: RawCell[][] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'This Excel file could not be opened', `The file may be damaged or password-protected (${(err as Error).message}). Save it again as .xlsx and retry.`);
  }
  const sheets = wb.worksheets.filter((s) => s.state === 'visible' && !SKIP_SHEETS.has(s.name.trim().toLowerCase()));
  const sheet = sheets.find((s) => s.actualRowCount > 0) ?? sheets[0];
  if (!sheet) throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'The Excel file has no data sheet');
  const grid: RawCell[][] = [];
  // Note: sheet.columnCount scans every row, so it is read once (templates have 1,500 formatted rows).
  const width = sheet.columnCount;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: RawCell[] = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellToRaw(row.getCell(c).value));
    grid[rowNumber - 1] = cells;
  });
  for (let i = 0; i < grid.length; i += 1) grid[i] ??= [];
  return { sheetName: sheet.name, grid };
}

// ------------------------------------------------------------------ header detection

function isBlank(v: RawCell | undefined): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function headerText(v: RawCell | undefined): string {
  return isBlank(v) ? '' : String(v).replace(/\s+/g, ' ').trim();
}

interface HeaderPick {
  index: number;
  headers: string[];
  mapping: Record<string, string>;
  unknown: string[];
  matches: number;
}

/**
 * Finds the header row among the first rows (title rows above it are skipped) and combines merged group headers
 * from the row above, e.g. "Guardian 1" spanning columns over "Name | Phone" → "Guardian 1 Name", "Guardian 1 Phone".
 */
export function pickHeader(grid: RawCell[][], type: ImportType): HeaderPick {
  const lookup = headerLookup(type);
  let best: HeaderPick | null = null;
  for (let r = 0; r < Math.min(grid.length, 8); r += 1) {
    const row = grid[r] ?? [];
    const above = r > 0 ? (grid[r - 1] ?? []) : [];
    // carry merged/group header values to the right (Excel stores them only in the first cell of a merge)
    const groups: string[] = [];
    let last = '';
    for (let c = 0; c < Math.max(row.length, above.length); c += 1) {
      const t = headerText(above[c]);
      if (t) last = t;
      else if (isBlank(row[c])) last = '';
      groups.push(last);
    }
    const headers: string[] = [];
    const mapping: Record<string, string> = {};
    const unknown: string[] = [];
    const used = new Set<string>();
    let matches = 0;
    row.forEach((cell, c) => {
      const own = headerText(cell);
      if (!own) {
        headers.push('');
        return;
      }
      const group = groups[c] ?? '';
      const candidates = group && group !== own ? [`${group} ${own}`, own] : [own];
      let label = candidates[0]!;
      let key: string | undefined;
      for (const cand of candidates) {
        const k = lookup.get(normaliseHeader(cand));
        if (k && !used.has(k)) {
          key = k;
          label = cand;
          break;
        }
      }
      if (!key) label = own;
      // keep header labels unique so cells do not overwrite each other
      let unique = label;
      for (let n = 2; headers.includes(unique); n += 1) unique = `${label} (${n})`;
      headers.push(unique);
      if (key) {
        used.add(key);
        mapping[unique] = key;
        matches += 1;
      } else unknown.push(unique);
    });
    if (!best || matches > best.matches) best = { index: r, headers, mapping, unknown, matches };
  }
  if (!best || best.matches < 2) {
    throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'We could not find the column headings', 'The first row of the sheet should contain headings such as "First Name", "Last Name" and "Date of Birth". Download the template to see the expected headings.');
  }
  return best;
}

// ------------------------------------------------------------------ public entry point

export async function readImportFile(buffer: Buffer, type: ImportType, fileName = ''): Promise<ParsedFile> {
  if (buffer.length === 0) throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'The file is empty');
  const format = detectFormat(buffer, fileName);
  let grid: RawCell[][];
  let sheetName: string | null = null;
  if (format === 'xlsx') {
    ({ grid, sheetName } = await readXlsxGrid(buffer));
  } else {
    const text = decodeText(buffer);
    if (text.includes('\u0000')) throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'This file is not a spreadsheet', 'Upload an Excel (.xlsx) or CSV file.');
    grid = parseCsv(text);
  }
  const pick = pickHeader(grid, type);
  const rows: RawRow[] = [];
  for (let r = pick.index + 1; r < grid.length; r += 1) {
    const line = grid[r] ?? [];
    if (line.every((v) => isBlank(v))) continue; // blank rows are skipped
    const cells: Record<string, RawCell> = {};
    pick.headers.forEach((h, c) => {
      if (!h) return;
      const v = line[c];
      cells[h] = v === undefined ? null : typeof v === 'string' ? v : v;
    });
    // skip rows that only repeat the header (common when sheets are pasted together)
    if (pick.headers.every((h, c) => !h || headerText(line[c]) === h || isBlank(line[c]))) continue;
    rows.push({ rowNumber: r + 1, cells });
  }
  if (rows.length === 0) throw new AppError(400, 'IMPORT_FILE_UNREADABLE', 'The file has headings but no data rows');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(400, 'IMPORT_FILE_UNREADABLE', `The file has more than ${MAX_IMPORT_ROWS} rows`, `It has ${rows.length} rows. Split it into smaller files (for example one per level) and import them one after another.`);
  }
  return { format, sheetName, headers: pick.headers.filter((h) => h), mapping: pick.mapping, unknownHeaders: pick.unknown, headerRowNumber: pick.index + 1, rows };
}
