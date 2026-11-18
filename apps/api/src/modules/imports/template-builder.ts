import ExcelJS from 'exceljs';
import { DEFAULT_CLASS_OPTIONS, TEMPLATE_SPECS, templateColumns, type ColumnSpec, type ImportType } from './import-columns';

export interface TemplateOptions {
  /** Real class names for the current academic year (e.g. "P3 A"). Falls back to the seeded level list. */
  classOptions?: string[];
  /** Real term labels (e.g. "2026/2027 Term 1"). */
  termOptions?: string[];
}

/** Rows that get dropdowns / formatting in the data sheet (header is row 1). */
export const TEMPLATE_DATA_ROWS = 1500;
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));

const DEFAULT_TERMS = ['2026/2027 Term 1', '2026/2027 Term 2', '2026/2027 Term 3'];

/**
 * Builds a downloadable import template: Instructions sheet (plain English), data sheet with headers,
 * dropdowns and 3 FAKE example rows, and a hidden Lists sheet that feeds the dropdowns.
 */
export async function buildTemplate(type: ImportType, opts: TemplateOptions = {}): Promise<Buffer> {
  const spec = TEMPLATE_SPECS[type];
  const columns = templateColumns(type);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kansview School Management System';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;

  const listRefs = new Map<string, string>();
  const optionsFor = (c: ColumnSpec): readonly string[] | undefined => {
    if (c.kind === 'class') return opts.classOptions?.length ? opts.classOptions : DEFAULT_CLASS_OPTIONS;
    if (c.kind === 'term') return opts.termOptions?.length ? opts.termOptions : DEFAULT_TERMS;
    return c.options;
  };

  // ---- Instructions
  const ins = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FF1F6FB2' } } });
  ins.getColumn(1).width = 34;
  ins.getColumn(2).width = 12;
  ins.getColumn(3).width = 90;
  ins.addRow([`How to fill in the ${spec.title} template`]).font = { bold: true, size: 14 };
  ins.addRow([]);
  for (const p of spec.intro) {
    const r = ins.addRow([p]);
    ins.mergeCells(r.number, 1, r.number, 3);
    r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    r.height = Math.max(18, Math.ceil(p.length / 120) * 16);
  }
  ins.addRow([]);
  const head = ins.addRow(['Column', 'Required?', 'What to type']);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  });
  for (const c of columns) {
    const options = optionsFor(c);
    const help = options && c.kind !== 'class' && c.kind !== 'term' ? `${c.help} Choices: ${options.join(', ')}.` : c.help;
    const r = ins.addRow([c.header, c.required ? 'Yes *' : 'No', help]);
    r.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  }
  ins.addRow([]);
  ins.addRow(['When you are ready: save the file, open Imports in the system, upload it and click "Check file" (dry run). Nothing is saved until you click "Commit".']);
  ins.mergeCells(ins.rowCount, 1, ins.rowCount, 3);

  // ---- Data sheet
  const ws = wb.addWorksheet(spec.dataSheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 4) }));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: 'middle' };
  header.height = 30;
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFFCE4D6' : 'FFEDEDED' } };
    cell.note = c.help;
  });
  for (const ex of spec.examples) {
    const row = ws.addRow(columns.map((c) => ex[c.key] ?? ''));
    row.font = { italic: true, color: { argb: 'FF7F7F7F' } };
  }
  // Text format everywhere so Excel keeps leading zeros on phone numbers and does not reformat dates.
  columns.forEach((_c, i) => {
    ws.getColumn(i + 1).numFmt = '@';
  });

  // ---- Lists (hidden) + dropdowns
  const listSheet = wb.addWorksheet('Lists', { state: 'hidden' });
  let listCol = 0;
  columns.forEach((c, i) => {
    const options = optionsFor(c);
    if (!options?.length) return;
    const listKey = c.kind === 'yesno' ? 'yesno' : c.key;
    let ref = listRefs.get(listKey);
    if (!ref) {
      listCol += 1;
      listSheet.getCell(1, listCol).value = c.kind === 'yesno' ? 'Yes/No' : c.header;
      options.forEach((o, j) => {
        listSheet.getCell(j + 2, listCol).value = o;
      });
      const letter = listSheet.getColumn(listCol).letter;
      ref = `Lists!$${letter}$2:$${letter}$${options.length + 1}`;
      listRefs.set(listKey, ref);
    }
    for (let r = 2; r <= TEMPLATE_DATA_ROWS + 1; r += 1) {
      ws.getCell(r, i + 1).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [ref],
        showErrorMessage: c.kind !== 'class', // classes: warn only, so a school can type its own class name
        errorStyle: c.kind === 'class' ? 'warning' : 'stop',
        errorTitle: 'Please pick from the list',
        error: `Choose one of the values in the list for "${c.header}".`,
      };
    }
  });

  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function templateFileName(type: ImportType): string {
  return `${type.replace(/_/g, '-')}-import-template.xlsx`;
}
