import ExcelJS from 'exceljs';
import type { RawCell } from './file-reader';
import type { RowMessage, RowStatus } from './row-validation';

export interface ReportRow {
  rowNumber: number;
  status: RowStatus;
  raw: Record<string, RawCell>;
  messages: RowMessage[];
  note?: string;
}

/**
 * Error report: the original columns (so the sheet can be fixed and uploaded again as a new import),
 * plus "Row in your file", "Status" and "Errors" / "Warnings" columns. Plain-English messages.
 */
export async function buildErrorReport(headers: string[], rows: ReportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rows to fix', { views: [{ state: 'frozen', ySplit: 1 }] });
  const extra = ['Errors', 'Warnings', 'Row in your file', 'Status'];
  ws.addRow([...headers, ...extra]);
  ws.getRow(1).font = { bold: true };
  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = Math.max(12, Math.min(30, h.length + 4));
    ws.getColumn(i + 1).numFmt = '@';
  });
  ws.getColumn(headers.length + 1).width = 70;
  ws.getColumn(headers.length + 2).width = 50;
  for (let i = headers.length + 1; i <= headers.length + extra.length; i += 1) {
    ws.getRow(1).getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
  }
  const label: Record<RowStatus, string> = { error: 'Not imported: fix the errors', duplicate: 'Possible duplicate: decide in the system', warning: 'Will be imported (check warnings)', valid: 'OK' };
  for (const r of rows) {
    const errors = r.messages.filter((m) => m.severity === 'error').map((m) => m.message);
    const warnings = r.messages.filter((m) => m.severity === 'warning').map((m) => m.message);
    if (r.note) errors.push(r.note);
    const line = ws.addRow([...headers.map((h) => r.raw[h] ?? null), errors.join('\n'), warnings.join('\n'), r.rowNumber, r.note ?? label[r.status]]);
    line.getCell(headers.length + 1).alignment = { wrapText: true, vertical: 'top' };
    line.getCell(headers.length + 2).alignment = { wrapText: true, vertical: 'top' };
    if (errors.length) line.getCell(headers.length + 1).font = { color: { argb: 'FFC00000' } };
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
