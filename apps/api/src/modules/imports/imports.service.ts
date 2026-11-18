import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { IMPORT_TARGET, type ImportTarget } from '../../common/contracts';
import { pageOffset, type Page, type PageQuery } from '../../common/pagination';
import { AUDIT_SERVICE, UPLOAD_PIPELINE, UPLOAD_POLICIES, type AuditService, type AuthUser, type UploadPipeline } from '../../security';
import { readImportFile, type RawCell } from './file-reader';
import type { ImportType } from './import-columns';
import { allowedImportTypes, assertCanCommit, assertTypeAllowed } from './import-access';
import { dryRun, type Resolution, type StoredNormalised } from './import-dry-run';
import { findGuardiansByPhone, loadClasses, loadContext, currentAcademicYear, loadTerms } from './import-lookups';
import { postOpeningBalance, writeStaff, writeStudent } from './import-writers';
import { missingRequiredColumns, type NormalisedBalance, type NormalisedStaff, type NormalisedStudent, type RowMessage, type RowStatus } from './row-validation';
import { buildTemplate } from './template-builder';
import { buildErrorReport } from './error-report';

/** Rows committed per transaction (schema.md §8). */
export const COMMIT_BATCH_SIZE = 200;

export interface FileMeta {
  format: 'xlsx' | 'csv';
  sheetName: string | null;
  headers: string[];
  mapping: Record<string, string>;
  unknownHeaders: string[];
  headerRowNumber: number;
}

export interface ImportTotals {
  rows: number;
  valid: number;
  warning: number;
  error: number;
  duplicate: number;
  unresolvedDuplicates: number;
  skipped: number;
  /** Rows that a commit would write now. */
  toCommit: number;
  committed: number;
  failed: number;
}

interface StoredTotals extends Partial<ImportTotals> {
  file?: FileMeta;
}

export interface ImportJobDto {
  id: string;
  type: ImportType;
  status: 'uploaded' | 'validated' | 'committing' | 'committed' | 'failed';
  originalFilename: string | null;
  totals: ImportTotals;
  unknownHeaders: string[];
  missingColumns: string[];
  error: string | null;
  createdAt: string;
  createdBy: string | null;
  validatedAt: string | null;
  committedAt: string | null;
  committedBy: string | null;
}

export interface ImportRowDto {
  rowNumber: number;
  status: RowStatus;
  messages: RowMessage[];
  raw: Record<string, RawCell>;
  normalised: Omit<StoredNormalised, 'duplicates' | 'resolution'> | null;
  duplicates: unknown[];
  resolution: Resolution | null;
  committed: boolean;
  targetStudentId: string | null;
  targetStaffId: string | null;
  targetGuardianIds: string[];
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
  size: number;
}

type JobRow = {
  id: string;
  type: ImportType;
  status: ImportJobDto['status'];
  original_filename: string | null;
  totals: unknown;
  error: string | null;
  created_at: Date;
  created_by: string | null;
  validated_at: Date | null;
  committed_at: Date | null;
  committed_by: string | null;
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

@Injectable()
export class ImportsService {
  private readonly logger = new Logger('ImportsService');

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(IMPORT_TARGET) private readonly importTarget: ImportTarget,
    @Inject(UPLOAD_PIPELINE) private readonly uploads: UploadPipeline,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- templates

  async template(type: ImportType, user: AuthUser): Promise<Buffer> {
    assertTypeAllowed(user, type);
    const year = await currentAcademicYear(this.db);
    const classOptions = year ? (await loadClasses(this.db, year.id)).map((c) => c.displayName) : [];
    const termOptions = (await loadTerms(this.db)).map((t) => `${t.yearName} Term ${t.number}`);
    return buildTemplate(type, { classOptions, termOptions });
  }

  // ---------------------------------------------------------------- jobs

  private toDto(j: JobRow): ImportJobDto {
    const t = (j.totals ?? {}) as StoredTotals;
    const file = t.file;
    const totals: ImportTotals = {
      rows: t.rows ?? 0, valid: t.valid ?? 0, warning: t.warning ?? 0, error: t.error ?? 0, duplicate: t.duplicate ?? 0,
      unresolvedDuplicates: t.unresolvedDuplicates ?? 0, skipped: t.skipped ?? 0, toCommit: t.toCommit ?? 0, committed: t.committed ?? 0, failed: t.failed ?? 0,
    };
    return {
      id: j.id,
      type: j.type,
      status: j.status,
      originalFilename: j.original_filename,
      totals,
      unknownHeaders: file?.unknownHeaders ?? [],
      missingColumns: file ? missingRequiredColumns(j.type, file.mapping) : [],
      error: j.error,
      createdAt: iso(j.created_at)!,
      createdBy: j.created_by,
      validatedAt: iso(j.validated_at),
      committedAt: iso(j.committed_at),
      committedBy: j.committed_by,
    };
  }

  private jobQuery(q: Db | Tx) {
    return q.selectFrom('import.jobs').select(['id', 'type', 'status', 'original_filename', 'totals', 'error', 'created_at', 'created_by', 'validated_at', 'committed_at', 'committed_by']);
  }

  /** Loads a job the user may see; other types are reported as not found (no id probing). */
  private async loadJob(id: string, user: AuthUser, q: Db | Tx = this.db, forUpdate = false): Promise<JobRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw AppError.notFound('import');
    let query = this.jobQuery(q).where('id', '=', id);
    if (forUpdate) query = query.forUpdate();
    const job = (await query.executeTakeFirst()) as JobRow | undefined;
    if (!job || !allowedImportTypes(user).has(job.type)) throw AppError.notFound('import');
    return job;
  }

  async list(user: AuthUser, q: PageQuery): Promise<Page<ImportJobDto>> {
    const types = [...allowedImportTypes(user)];
    if (types.length === 0) return { data: [], page: q.page, pageSize: q.pageSize, total: 0 };
    const { limit, offset } = pageOffset(q);
    const [rows, count] = await Promise.all([
      this.jobQuery(this.db).where('type', 'in', types).orderBy('created_at', 'desc').limit(limit).offset(offset).execute(),
      this.db.selectFrom('import.jobs').select((eb) => eb.fn.countAll<number>().as('n')).where('type', 'in', types).executeTakeFirstOrThrow(),
    ]);
    return { data: (rows as JobRow[]).map((r) => this.toDto(r)), page: q.page, pageSize: q.pageSize, total: Number(count.n) };
  }

  async get(id: string, user: AuthUser): Promise<ImportJobDto> {
    return this.toDto(await this.loadJob(id, user));
  }

  /** Upload: checks and parses the file, stores the original through the upload pipeline and keeps every row in staging. */
  async upload(type: ImportType, file: UploadedFile | undefined, user: AuthUser): Promise<ImportJobDto> {
    assertTypeAllowed(user, type);
    if (!file?.buffer?.length) throw new AppError(400, 'VALIDATION_FAILED', 'Choose a file to upload', undefined, [{ field: 'file', code: 'REQUIRED', message: 'Choose an Excel (.xlsx) or CSV file' }]);
    if (file.size > UPLOAD_POLICIES.importFile.maxBytes) throw new AppError(413, 'FILE_TOO_LARGE', 'The file is too large', 'Import files can be up to 10 MB. Split the file into smaller files.');
    const parsed = await readImportFile(file.buffer, type, file.originalname);
    const fileId = await this.storeOriginal(file, parsed.format, user);
    const meta: FileMeta = { format: parsed.format, sheetName: parsed.sheetName, headers: parsed.headers, mapping: parsed.mapping, unknownHeaders: parsed.unknownHeaders, headerRowNumber: parsed.headerRowNumber };
    const totals: StoredTotals = { rows: parsed.rows.length, file: meta };
    const job = await this.db.transaction().execute(async (tx) => {
      const j = await tx
        .insertInto('import.jobs')
        .values({ type, file_id: fileId, original_filename: file.originalname.slice(0, 255), status: 'uploaded', totals: JSON.stringify(totals), created_by: user.id, updated_by: user.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (let i = 0; i < parsed.rows.length; i += 500) {
        await tx
          .insertInto('import.rows')
          .values(parsed.rows.slice(i, i + 500).map((r) => ({ job_id: j.id, row_number: r.rowNumber, raw: JSON.stringify(r.cells), status: 'valid' as const, messages: '[]' })))
          .execute();
      }
      await this.audit.record({ action: 'create', entityType: 'import_job', entityId: j.id, changes: { type: { after: type }, rows: { after: parsed.rows.length }, fileName: { after: file.originalname } } }, user, tx);
      return this.loadJob(j.id, user, tx);
    });
    this.logger.log({ jobId: job.id, type, rows: parsed.rows.length, userId: user.id }, 'import uploaded');
    return this.toDto(job);
  }

  /**
   * Keeps the original file via the upload pipeline (magic bytes, size, malware scan).
   * TEMPORARY: while Agent D's pipeline is still the 501 stub the job is created without a stored file
   * (the rows are already in staging), and a warning is logged.
   */
  private async storeOriginal(file: UploadedFile, format: 'xlsx' | 'csv', user: AuthUser): Promise<string | null> {
    const declaredMimeType = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
    try {
      const accepted = await this.uploads.accept({ originalName: file.originalname, buffer: file.buffer, declaredMimeType }, UPLOAD_POLICIES.importFile, user.id);
      if (accepted.scanStatus === 'infected') throw new AppError(422, 'FILE_INFECTED', 'This file failed the virus check and was not accepted');
      return accepted.fileId;
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_IMPLEMENTED') {
        this.logger.warn({ userId: user.id }, 'upload pipeline not available yet; import file kept in staging rows only');
        return null;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- dry run

  /**
   * Dry run (synchronous: files are capped at 2,000 rows, which validates in a few seconds).
   * Only import.rows / import.jobs are written. Re-running keeps earlier duplicate decisions when they still apply.
   */
  async validate(id: string, user: AuthUser): Promise<ImportJobDto> {
    const job = await this.loadJob(id, user);
    assertTypeAllowed(user, job.type);
    if (job.status !== 'uploaded' && job.status !== 'validated') {
      throw new AppError(409, 'IMPORT_INVALID_STATE', 'This import has already been committed (or is being committed) and cannot be checked again', 'Upload the file again as a new import.');
    }
    const meta = ((job.totals ?? {}) as StoredTotals).file;
    if (!meta) throw new AppError(409, 'IMPORT_INVALID_STATE', 'This import has no file data');
    const missing = missingRequiredColumns(job.type, meta.mapping);
    if (missing.length) {
      throw new AppError(422, 'IMPORT_FILE_UNREADABLE', 'Some required columns are missing', `Add these columns to the file and upload it again: ${missing.join(', ')}.`, missing.map((m) => ({ field: m, code: 'MISSING_COLUMN', message: `Column "${m}" is missing` })));
    }
    const { ctx, year } = await loadContext(this.db);
    if (job.type === 'students_guardians' && (!year || ctx.classes.length === 0)) {
      throw new AppError(422, 'IMPORT_INVALID_STATE', 'Set up the current academic year and its classes first', 'Students are placed in this year\'s classes, so the classes must exist before the import can be checked.');
    }
    const stored = await this.db.selectFrom('import.rows').select(['row_number', 'raw', 'normalised']).where('job_id', '=', id).orderBy('row_number').execute();
    const previous = new Map(stored.map((r) => [r.row_number, (r.normalised as StoredNormalised | null)?.resolution ?? null]));
    const started = Date.now();
    const result = await dryRun(this.db, job.type, stored.map((r) => ({ rowNumber: r.row_number, cells: r.raw as Record<string, RawCell> })), meta.mapping, ctx);
    for (const r of result) {
      const prev = previous.get(r.rowNumber);
      if (r.normalised && prev && (prev.action === 'skip' || (r.status === 'duplicate' && this.resolutionStillValid(prev, r.normalised)))) r.normalised.resolution = prev;
    }

    await this.db.transaction().execute(async (tx) => {
      const locked = await this.loadJob(id, user, tx, true);
      if (locked.status !== 'uploaded' && locked.status !== 'validated') throw new AppError(409, 'IMPORT_INVALID_STATE', 'This import changed while it was being checked. Refresh and try again.');
      const payload = JSON.stringify(result.map((r) => ({ row_number: r.rowNumber, status: r.status, messages: r.messages, normalised: r.normalised })));
      await sql`
        UPDATE import.rows r SET status = v.status::import.row_status, messages = v.messages, normalised = v.normalised, updated_at = now()
          FROM jsonb_to_recordset(${payload}::jsonb) AS v(row_number int, status text, messages jsonb, normalised jsonb)
         WHERE r.job_id = ${id} AND r.row_number = v.row_number`.execute(tx);
      await tx.updateTable('import.jobs').set({ status: 'validated', validated_at: new Date(), updated_by: user.id, error: null }).where('id', '=', id).execute();
      await this.refreshTotals(tx, id);
    });
    this.logger.log({ jobId: id, rows: result.length, ms: Date.now() - started }, 'import validated');
    return this.get(id, user);
  }

  private resolutionStillValid(prev: Resolution, n: StoredNormalised): boolean {
    if (prev.action !== 'link_existing') return true;
    return (n.duplicates ?? []).some((d) => ('studentId' in d ? d.studentId : d.staffId) === prev.existingId);
  }

  /** Recomputes totals from the staging rows (keeps file metadata). */
  private async refreshTotals(q: Db | Tx, id: string): Promise<void> {
    const r = await sql<ImportTotals>`
      SELECT count(*)::int AS rows,
             count(*) FILTER (WHERE status = 'valid')::int AS valid,
             count(*) FILTER (WHERE status = 'warning')::int AS warning,
             count(*) FILTER (WHERE status = 'error')::int AS error,
             count(*) FILTER (WHERE status = 'duplicate')::int AS duplicate,
             count(*) FILTER (WHERE status = 'duplicate' AND committed_at IS NULL AND coalesce(normalised->'resolution', 'null'::jsonb) = 'null'::jsonb)::int AS "unresolvedDuplicates",
             count(*) FILTER (WHERE committed_at IS NULL AND normalised->'resolution'->>'action' = 'skip')::int AS skipped,
             count(*) FILTER (WHERE ${this.eligibleSql()})::int AS "toCommit",
             count(*) FILTER (WHERE committed_at IS NOT NULL)::int AS committed,
             count(*) FILTER (WHERE committed_at IS NULL AND messages @> '[{"code":"COMMIT_FAILED"}]'::jsonb)::int AS failed
        FROM import.rows WHERE job_id = ${id}`.execute(q);
    await sql`UPDATE import.jobs SET totals = totals || ${JSON.stringify(r.rows[0])}::jsonb WHERE id = ${id}`.execute(q);
  }

  /** Rows a commit writes: valid/warning rows not skipped, and duplicates the user resolved as link/create. */
  private eligibleSql() {
    return sql<boolean>`committed_at IS NULL AND (
      (status IN ('valid', 'warning') AND coalesce(normalised->'resolution'->>'action', '') <> 'skip')
      OR (status = 'duplicate' AND normalised->'resolution'->>'action' IN ('link_existing', 'create_new')))`;
  }

  // ---------------------------------------------------------------- rows

  async rows(id: string, user: AuthUser, status: RowStatus | undefined, q: PageQuery): Promise<Page<ImportRowDto>> {
    await this.loadJob(id, user);
    const { limit, offset } = pageOffset(q);
    let base = this.db.selectFrom('import.rows').where('job_id', '=', id);
    if (status) base = base.where('status', '=', status);
    const [rows, count] = await Promise.all([
      base.select(['row_number', 'status', 'messages', 'raw', 'normalised', 'committed_at', 'target_student_id', 'target_staff_id', 'target_guardian_ids']).orderBy('row_number').limit(limit).offset(offset).execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { data: rows.map((r) => this.rowDto(r)), page: q.page, pageSize: q.pageSize, total: Number(count.n) };
  }

  private rowDto(r: { row_number: number; status: RowStatus; messages: unknown; raw: unknown; normalised: unknown; committed_at: Date | null; target_student_id: string | null; target_staff_id: string | null; target_guardian_ids: string[] }): ImportRowDto {
    const n = r.normalised as StoredNormalised | null;
    let normalised: ImportRowDto['normalised'] = null;
    if (n) {
      const { duplicates: _d, resolution: _r, ...rest } = n;
      normalised = rest;
    }
    return {
      rowNumber: r.row_number,
      status: r.status,
      messages: (r.messages as unknown as RowMessage[]) ?? [],
      raw: (r.raw as Record<string, RawCell>) ?? {},
      normalised,
      duplicates: (n?.duplicates as unknown[]) ?? [],
      resolution: n?.resolution ?? null,
      committed: !!r.committed_at,
      targetStudentId: r.target_student_id,
      targetStaffId: r.target_staff_id,
      targetGuardianIds: r.target_guardian_ids ?? [],
    };
  }

  /** Records the user's decision for a row: link a duplicate to the existing record, create it anyway, skip it, or undo a skip. */
  async resolve(id: string, rowNumber: number, body: { action: Resolution['action'] | 'include'; existingId?: string | undefined }, user: AuthUser): Promise<ImportRowDto> {
    return this.db.transaction().execute(async (tx) => {
      const job = await this.loadJob(id, user, tx, true);
      assertTypeAllowed(user, job.type);
      if (job.status !== 'validated') throw new AppError(409, 'IMPORT_INVALID_STATE', job.status === 'uploaded' ? 'Check the file (dry run) before deciding on rows' : 'This import has already been committed');
      const row = await tx.selectFrom('import.rows').selectAll().where('job_id', '=', id).where('row_number', '=', rowNumber).forUpdate().executeTakeFirst();
      if (!row) throw AppError.notFound('row');
      if (row.committed_at) throw new AppError(409, 'IMPORT_INVALID_STATE', 'This row has already been imported');
      const n = row.normalised as StoredNormalised | null;
      if (row.status === 'error' || !n) throw new AppError(422, 'IMPORT_INVALID_STATE', 'Rows with errors cannot be imported', 'Fix the row in your file (see the error report) and upload it again.');
      let resolution: Resolution | null;
      if (body.action === 'include') resolution = null;
      else if (body.action === 'skip') resolution = { action: 'skip' };
      else {
        if (row.status !== 'duplicate') throw new AppError(422, 'IMPORT_INVALID_STATE', 'Only possible duplicates can be linked or created anyway');
        if (body.action === 'create_new') resolution = { action: 'create_new' };
        else {
          const ids = (n.duplicates ?? []).map((d) => ('studentId' in d ? d.studentId : d.staffId));
          const existingId = body.existingId ?? (ids.length === 1 ? ids[0] : undefined);
          if (!existingId || !ids.includes(existingId)) {
            throw new AppError(422, 'VALIDATION_FAILED', 'Choose which existing record to link to', undefined, [{ field: 'existingId', code: 'INVALID', message: 'Pick one of the possible duplicates listed for this row' }]);
          }
          if (job.type === 'opening_balances') throw new AppError(422, 'IMPORT_INVALID_STATE', 'Opening balances cannot be linked');
          resolution = { action: 'link_existing', existingId };
        }
      }
      const updated = await tx
        .updateTable('import.rows')
        .set({ normalised: JSON.stringify({ ...n, resolution }), updated_at: new Date() })
        .where('id', '=', row.id)
        .returning(['row_number', 'status', 'messages', 'raw', 'normalised', 'committed_at', 'target_student_id', 'target_staff_id', 'target_guardian_ids'])
        .executeTakeFirstOrThrow();
      await this.refreshTotals(tx, id);
      return this.rowDto(updated);
    });
  }

  // ---------------------------------------------------------------- error report

  async errorReport(id: string, user: AuthUser, includeAll: boolean): Promise<{ buffer: Buffer; fileName: string }> {
    const job = await this.loadJob(id, user);
    const meta = ((job.totals ?? {}) as StoredTotals).file;
    let q = this.db.selectFrom('import.rows').select(['row_number', 'status', 'raw', 'messages', 'normalised', 'committed_at']).where('job_id', '=', id);
    if (!includeAll) {
      q = q.where((eb) =>
        eb.or([
          eb('status', '=', 'error'),
          eb.and([eb('status', '=', 'duplicate'), eb('committed_at', 'is', null)]),
          sql<boolean>`committed_at IS NULL AND normalised->'resolution'->>'action' = 'skip'`,
          sql<boolean>`committed_at IS NULL AND messages @> '[{"code":"COMMIT_FAILED"}]'::jsonb`,
        ]),
      );
    }
    const rows = await q.orderBy('row_number').execute();
    const buffer = await buildErrorReport(
      meta?.headers ?? [],
      rows.map((r) => {
        const n = r.normalised as StoredNormalised | null;
        const note = r.committed_at ? 'Imported' : n?.resolution?.action === 'skip' ? 'Skipped (you chose to skip this row)' : undefined;
        return { rowNumber: r.row_number, status: r.status, raw: r.raw as Record<string, RawCell>, messages: r.messages as unknown as RowMessage[], ...(note ? { note } : {}) };
      }),
    );
    await this.audit.record({ action: 'export', entityType: 'import_job', entityId: id, changes: { report: { after: includeAll ? 'all_rows' : 'rows_to_fix' }, rows: { after: rows.length } } }, user);
    return { buffer, fileName: `import-${job.type.replace(/_/g, '-')}-${id.slice(0, 8)}-rows-to-fix.xlsx` };
  }

  // ---------------------------------------------------------------- commit

  /**
   * Commit: writes eligible rows in batches of 200, one transaction per batch. Each row is committed at most once
   * (rows are locked and re-checked for committed_at inside the batch), so a re-run after a crash or a second click
   * resumes where it stopped and never creates duplicates. A row that fails is rolled back to its savepoint,
   * marked COMMIT_FAILED and reported; the rest of the batch continues.
   */
  async commit(id: string, user: AuthUser): Promise<ImportJobDto> {
    const job = await this.loadJob(id, user);
    assertTypeAllowed(user, job.type);
    assertCanCommit(user, job.type);
    if (job.status === 'committed') return this.toDto(job);
    if (job.status === 'uploaded') throw new AppError(409, 'IMPORT_INVALID_STATE', 'Check the file (dry run) before committing');
    const pending = await this.db.selectFrom('import.rows').select((eb) => eb.fn.countAll<number>().as('n')).where('job_id', '=', id).where('status', '=', 'duplicate').where('committed_at', 'is', null).where(sql<boolean>`coalesce(normalised->'resolution', 'null'::jsonb) = 'null'::jsonb`).executeTakeFirstOrThrow();
    if (Number(pending.n) > 0) {
      throw new AppError(422, 'IMPORT_INVALID_STATE', `Decide what to do with ${pending.n} possible duplicate${Number(pending.n) === 1 ? '' : 's'} first`, 'For each one choose "link to existing", "create new" or "skip".', undefined, { unresolvedDuplicates: Number(pending.n) });
    }
    await this.db.updateTable('import.jobs').set({ status: 'committing', updated_by: user.id, error: null }).where('id', '=', id).where('status', 'in', ['validated', 'committing', 'failed']).execute();
    // rows that failed in an earlier run are retried once in this run
    await sql`
      UPDATE import.rows SET messages = coalesce((SELECT jsonb_agg(m) FROM jsonb_array_elements(messages) m WHERE m->>'code' <> 'COMMIT_FAILED'), '[]'::jsonb)
       WHERE job_id = ${id} AND committed_at IS NULL AND messages @> '[{"code":"COMMIT_FAILED"}]'::jsonb`.execute(this.db);
    const started = Date.now();
    const guardianIdsByPhone = new Map<string, string>();
    if (job.type === 'students_guardians') await this.loadCommittedGuardians(id, guardianIdsByPhone);

    try {
      for (;;) {
        const done = await this.db.transaction().execute((tx) => this.commitBatch(tx, id, job.type, user, guardianIdsByPhone));
        if (done === 0) break;
      }
    } catch (err) {
      this.logger.error({ jobId: id, err }, 'import commit stopped');
      await this.db.updateTable('import.jobs').set({ status: 'failed', error: 'The commit stopped before the end. Click Commit again to continue; rows already imported are not imported twice.' }).where('id', '=', id).execute();
      await this.refreshTotals(this.db, id);
      throw err;
    }

    await this.db.transaction().execute(async (tx) => {
      await this.refreshTotals(tx, id);
      const t = await tx.selectFrom('import.jobs').select('totals').where('id', '=', id).executeTakeFirstOrThrow();
      const totals = t.totals as StoredTotals;
      const failed = totals.failed ?? 0;
      await tx
        .updateTable('import.jobs')
        .set(
          failed > 0
            ? { status: 'failed', committed_by: user.id, updated_by: user.id, error: `${failed} row${failed === 1 ? '' : 's'} could not be imported. Download the error report to see why, then click Commit again to retry them.` }
            : { status: 'committed', committed_at: new Date(), committed_by: user.id, updated_by: user.id, error: null },
        )
        .where('id', '=', id)
        .execute();
      await this.audit.record({ action: 'create', entityType: 'import_commit', entityId: id, changes: { type: { after: job.type }, committed: { after: totals.committed }, failed: { after: totals.failed }, skipped: { after: totals.skipped } } }, user, tx);
    });
    this.logger.log({ jobId: id, ms: Date.now() - started }, 'import committed');
    return this.get(id, user);
  }

  /** Phone → guardian id for guardians created by rows of this job already committed (resume keeps siblings linked). */
  private async loadCommittedGuardians(id: string, map: Map<string, string>): Promise<void> {
    const rows = await this.db.selectFrom('import.rows').select(['normalised', 'target_guardian_ids']).where('job_id', '=', id).where('committed_at', 'is not', null).execute();
    for (const r of rows) {
      const n = r.normalised as NormalisedStudent | null;
      n?.guardians?.forEach((g, i) => {
        const gid = r.target_guardian_ids[i];
        if (gid) map.set(g.phonePrimary, gid);
      });
    }
  }

  private async commitBatch(tx: Tx, id: string, type: ImportType, user: AuthUser, guardianIdsByPhone: Map<string, string>): Promise<number> {
    const batch = await tx
      .selectFrom('import.rows')
      .select(['id', 'row_number', 'status', 'normalised', 'messages'])
      .where('job_id', '=', id)
      .where(this.eligibleSql())
      .where(sql<boolean>`NOT (messages @> '[{"code":"COMMIT_FAILED"}]'::jsonb)`)
      .orderBy('row_number')
      .limit(COMMIT_BATCH_SIZE)
      .forUpdate()
      .execute();
    if (batch.length === 0) return 0;
    // serialise concurrent commits of the same job batch by batch
    await tx.selectFrom('import.jobs').select('id').where('id', '=', id).forUpdate().execute();

    if (type === 'students_guardians') {
      const phones = batch.flatMap((r) => ((r.normalised as unknown as NormalisedStudent).guardians ?? []).map((g) => g.phonePrimary)).filter((p) => !guardianIdsByPhone.has(p));
      for (const [phone, g] of await findGuardiansByPhone(tx, phones)) guardianIdsByPhone.set(phone, g.id);
    }

    for (const r of batch) {
      const n = r.normalised as unknown as StoredNormalised;
      const link = n.resolution?.action === 'link_existing' ? n.resolution.existingId! : null;
      await sql`SAVEPOINT import_row`.execute(tx);
      const snapshot = new Map(guardianIdsByPhone);
      try {
        let set: { target_student_id?: string; target_staff_id?: string; target_guardian_ids?: string[] } = {};
        if (type === 'students_guardians') {
          if (link) set = { target_student_id: link };
          else {
            const res = await writeStudent(tx, this.importTarget, n as NormalisedStudent, guardianIdsByPhone, user.id);
            set = { target_student_id: res.studentId, target_guardian_ids: res.guardianIds };
          }
        } else if (type === 'staff') {
          set = { target_staff_id: link ?? (await writeStaff(tx, n as NormalisedStaff, user.id)) };
        } else {
          const b = n as NormalisedBalance;
          await postOpeningBalance(tx, b, user.id);
          set = { target_student_id: b.studentId! };
        }
        await tx.updateTable('import.rows').set({ ...set, committed_at: new Date(), updated_at: new Date() }).where('id', '=', r.id).execute();
        await sql`RELEASE SAVEPOINT import_row`.execute(tx);
      } catch (err) {
        await sql`ROLLBACK TO SAVEPOINT import_row`.execute(tx);
        guardianIdsByPhone.clear();
        for (const [k, v] of snapshot) guardianIdsByPhone.set(k, v);
        const message = err instanceof AppError ? `${err.title}${err.detail ? `. ${err.detail}` : ''}` : 'Could not be saved because of an unexpected problem. Tell the administrator.';
        if (!(err instanceof AppError) || err.status >= 500) this.logger.error({ jobId: id, rowNumber: r.row_number, err }, 'import row failed');
        else this.logger.warn({ jobId: id, rowNumber: r.row_number, code: err.code }, 'import row rejected');
        const messages = [...((r.messages as unknown as RowMessage[]) ?? []), { severity: 'error' as const, code: 'COMMIT_FAILED', message: `Not imported: ${message}` }];
        await tx.updateTable('import.rows').set({ messages: JSON.stringify(messages), updated_at: new Date() }).where('id', '=', r.id).execute();
      }
    }
    await this.refreshTotals(tx, id);
    return batch.length;
  }
}
