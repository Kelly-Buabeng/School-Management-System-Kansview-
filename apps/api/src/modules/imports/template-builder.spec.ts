import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildTemplate, templateFileName } from './template-builder';
import { IMPORT_TYPES, TEMPLATE_SPECS, templateColumns, type ImportType } from './import-columns';
import { readImportFile } from './file-reader';
import { validateRows, type ValidationContext } from './row-validation';

const DOCS_DIR = join(__dirname, '../../../../../docs/import-templates');

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

const CTX: ValidationContext = {
  today: '2026-11-17',
  academicYearStart: '2026-09-08',
  classes: ['P2 A', 'P5 B', 'JHS1 A'].map((d, i) => {
    const [level, stream] = d.split(' ');
    return { id: `c${i}`, levelCode: level!, stream: stream ?? null, displayName: d, capacity: 40, activeCount: 0 };
  }),
  terms: [{ id: 't1', yearName: '2026/2027', number: 1 }],
};

describe.each(IMPORT_TYPES)('template %s', (type: ImportType) => {
  it('has Instructions, a data sheet with headers, 3 example rows and dropdowns', async () => {
    const wb = await load(await buildTemplate(type));
    const spec = TEMPLATE_SPECS[type];
    expect(wb.worksheets[0]!.name).toBe('Instructions');
    const ins = wb.getWorksheet('Instructions')!;
    const insText = ins.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ');
    for (const c of templateColumns(type)) expect(insText).toContain(c.header);
    expect(insText).toContain('Commit');

    const ws = wb.getWorksheet(spec.dataSheetName)!;
    const headers = (ws.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(templateColumns(type).map((c) => (c.required ? `${c.header} *` : c.header)));
    expect(ws.actualRowCount).toBe(4);

    const withOptions = templateColumns(type).findIndex((c) => c.options || c.kind === 'class' || c.kind === 'term');
    expect(withOptions).toBeGreaterThanOrEqual(0);
    const dv = ws.getCell(2, withOptions + 1).dataValidation;
    expect(dv?.type).toBe('list');
    expect(String(dv?.formulae?.[0])).toMatch(/^Lists!/);
    expect(wb.getWorksheet('Lists')!.state).toBe('hidden');
  });

  it('example rows parse and validate cleanly (no errors)', async () => {
    const parsed = await readImportFile(await buildTemplate(type), type);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.unknownHeaders).toEqual([]);
    const outcomes = validateRows(type, parsed.rows, parsed.mapping, CTX);
    for (const o of outcomes) expect(o.messages.filter((m) => m.severity === 'error')).toEqual([]);
  });

  it('uses the real class / term list when given', async () => {
    const wb = await load(await buildTemplate(type, { classOptions: ['Basic 1 Gold'], termOptions: ['2030/2031 Term 2'] }));
    const lists = wb.getWorksheet('Lists')!.getSheetValues().flat();
    if (type === 'students_guardians') expect(lists).toContain('Basic 1 Gold');
    if (type === 'opening_balances') expect(lists).toContain('2030/2031 Term 2');
  });

  it('the committed copy in docs/import-templates matches the generator', async () => {
    const path = join(DOCS_DIR, templateFileName(type));
    if (process.env.SMS_WRITE_IMPORT_TEMPLATES === '1' || !existsSync(path)) {
      mkdirSync(DOCS_DIR, { recursive: true });
      writeFileSync(path, await buildTemplate(type));
    }
    const committed = await load(await readFile(path));
    const fresh = await load(await buildTemplate(type));
    for (const name of ['Instructions', TEMPLATE_SPECS[type].dataSheetName, 'Lists']) {
      expect(JSON.stringify(committed.getWorksheet(name)!.getSheetValues()), `${name} sheet differs: run SMS_WRITE_IMPORT_TEMPLATES=1 vitest`).toBe(JSON.stringify(fresh.getWorksheet(name)!.getSheetValues()));
    }
  });
});
