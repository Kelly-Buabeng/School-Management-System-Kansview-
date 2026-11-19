import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { readImportFile } from './file-reader';
import { assertSafeImportXlsx, IMPORT_XLSX_LIMITS } from './xlsx-guard';
import { checkXlsx } from '../../security/file-sniffer';
import { AppError } from '../../common/app-error';
import { messyStudentsWorkbook } from '../../../test/g/fixtures';
import { xlsxBomb } from '../../../test/g/zip-bomb';

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('import zip-bomb guard (CP5-03)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a high-ratio xlsx is refused with 422 before ExcelJS opens it, using little memory', async () => {
    const bomb = await xlsxBomb(120, 'honest');
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const opened = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get');
    const rssBefore = process.memoryUsage().rss;
    const err = await rejection(readImportFile(bomb, 'students_guardians', 'pupils.xlsx'));
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(422);
    expect(err.title).toMatch(/too large to open safely/);
    expect(opened).not.toHaveBeenCalled();
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(150 * 1024 * 1024);
  });

  it('a bomb whose zip directory lies about the sizes is still refused before ExcelJS opens it', async () => {
    const bomb = await xlsxBomb(120, 'lying');
    expect(checkXlsx(bomb)).toBeNull(); // the declared sizes look harmless
    const opened = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get');
    const rssBefore = process.memoryUsage().rss;
    const err = await rejection(readImportFile(bomb, 'students_guardians', 'pupils.xlsx'));
    expect(err.status).toBe(422);
    expect(opened).not.toHaveBeenCalled();
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(150 * 1024 * 1024);
  });

  it('a workbook just over the limit is refused; a normal workbook passes', async () => {
    const over = await xlsxBomb(IMPORT_XLSX_LIMITS.maxTotalUncompressed / 1024 / 1024 + 1, 'lying');
    expect(() => assertSafeImportXlsx(over)).toThrow(/too large/);
    const ok = await messyStudentsWorkbook();
    expect(() => assertSafeImportXlsx(ok)).not.toThrow();
    const parsed = await readImportFile(ok, 'students_guardians', 'pupils.xlsx');
    expect(parsed.rows.length).toBeGreaterThan(0);
  });
});
