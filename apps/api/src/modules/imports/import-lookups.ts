/**
 * Database look-ups used by the dry run and the commit. Read-only; batched so a 2,000-row file needs a handful of queries.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '@sms/db-types';
import { todayInAccra } from '@sms/shared';
import type { ClassInfo, TermInfo, ValidationContext } from './row-validation';

type Q = Kysely<DB>;

export interface DuplicateCandidate {
  studentId: string;
  studentCode: string;
  name: string;
  dateOfBirth: string;
  similarity: number;
  sharedGuardianPhone: boolean;
  reason: string;
}

export interface CurrentYear {
  id: string;
  name: string;
  startDate: string;
}

export async function currentAcademicYear(db: Q): Promise<CurrentYear | null> {
  const r = await db.selectFrom('academic_years').select(['id', 'name', 'start_date']).where('status', '=', 'current').executeTakeFirst();
  return r ? { id: r.id, name: r.name, startDate: String(r.start_date) } : null;
}

export async function loadClasses(db: Q, academicYearId: string): Promise<ClassInfo[]> {
  const rows = await sql<{ id: string; level_code: string; stream: string | null; display_name: string; capacity: number | null; active_count: number }>`
    SELECT c.id, l.code AS level_code, c.stream, c.display_name, c.capacity,
           (SELECT count(*)::int FROM enrolments e WHERE e.class_id = c.id AND e.end_date IS NULL) AS active_count
      FROM classes c JOIN levels l ON l.id = c.level_id
     WHERE c.academic_year_id = ${academicYearId} AND c.archived_at IS NULL
     ORDER BY l.sort_order, c.stream NULLS FIRST`.execute(db);
  return rows.rows.map((r) => ({ id: r.id, levelCode: r.level_code, stream: r.stream, displayName: r.display_name, capacity: r.capacity, activeCount: r.active_count }));
}

export async function loadTerms(db: Q): Promise<TermInfo[]> {
  const rows = await db
    .selectFrom('terms as t')
    .innerJoin('academic_years as y', 'y.id', 't.academic_year_id')
    .select(['t.id', 't.number', 'y.name as year_name'])
    .orderBy('y.start_date')
    .orderBy('t.number')
    .execute();
  return rows.map((r) => ({ id: r.id, yearName: r.year_name, number: r.number }));
}

export async function loadContext(db: Q, now = new Date()): Promise<{ ctx: ValidationContext; year: CurrentYear | null }> {
  const year = await currentAcademicYear(db);
  const today = todayInAccra(now);
  const [classes, terms] = await Promise.all([year ? loadClasses(db, year.id) : Promise.resolve([]), loadTerms(db)]);
  return { ctx: { today, academicYearStart: year?.startDate ?? today, classes, terms }, year };
}

/**
 * Possible duplicates already in the database: the same rule as admission — similar name (trigram similarity ≥ 0.6)
 * and the same date of birth; a shared guardian phone is reported as extra evidence. Also matches an Old Student ID
 * that an earlier committed import already brought in.
 */
export async function findExistingStudents(
  db: Q,
  rows: Array<{ rowNumber: number; fullName: string; dateOfBirth: string; phones: string[]; legacyId: string | null }>,
): Promise<Map<number, DuplicateCandidate[]>> {
  const out = new Map<number, DuplicateCandidate[]>();
  if (rows.length === 0) return out;
  const payload = JSON.stringify(rows.map((r) => ({ rn: r.rowNumber, name: r.fullName.toLowerCase(), dob: r.dateOfBirth, phones: r.phones, legacy: r.legacyId })));
  const res = await sql<{ rn: number; id: string; student_code: string; name: string; date_of_birth: string; sim: number; shared_phone: boolean; legacy_match: boolean }>`
    WITH v AS (SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS v(rn int, name text, dob date, phones text[], legacy text)),
    by_name AS (
      SELECT v.rn, s.id,
             greatest(similarity(lower(s.first_name || ' ' || coalesce(s.middle_names || ' ', '') || s.last_name), v.name),
                      similarity(lower(s.first_name || ' ' || s.last_name), v.name)) AS sim,
             false AS legacy_match
        FROM v JOIN students s ON s.date_of_birth = v.dob AND s.archived_at IS NULL
    ),
    by_legacy AS (
      SELECT v.rn, r.target_student_id AS id, 1.0::real AS sim, true AS legacy_match
        FROM v JOIN import.rows r ON v.legacy IS NOT NULL AND r.normalised->>'legacyId' = v.legacy
        JOIN import.jobs j ON j.id = r.job_id AND j.type = 'students_guardians'
       WHERE r.committed_at IS NOT NULL AND r.target_student_id IS NOT NULL
    ),
    hits AS (
      SELECT rn, id, max(sim) AS sim, bool_or(legacy_match) AS legacy_match
        FROM (SELECT * FROM by_name WHERE sim >= 0.6 UNION ALL SELECT * FROM by_legacy) x GROUP BY rn, id
    )
    SELECT h.rn, s.id, s.student_code, s.first_name || ' ' || s.last_name AS name, s.date_of_birth::text AS date_of_birth,
           h.sim::float8 AS sim, h.legacy_match,
           EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                    WHERE sg.student_id = s.id
                      AND (g.phone_primary = ANY (v.phones) OR g.phone_secondary = ANY (v.phones))) AS shared_phone
      FROM hits h JOIN students s ON s.id = h.id JOIN v ON v.rn = h.rn
     ORDER BY h.rn, h.sim DESC`.execute(db);
  for (const r of res.rows) {
    const reason = r.legacy_match
      ? 'Same Old Student ID was imported before'
      : `Similar name and same date of birth${r.shared_phone ? ', and shares a guardian phone' : ''}`;
    const list = out.get(r.rn) ?? [];
    list.push({ studentId: r.id, studentCode: r.student_code, name: r.name, dateOfBirth: r.date_of_birth, similarity: Math.round(r.sim * 100) / 100, sharedGuardianPhone: r.shared_phone, reason });
    out.set(r.rn, list);
  }
  return out;
}

/** Existing guardians by phone (primary, secondary or WhatsApp). Earliest created wins when several match. */
export async function findGuardiansByPhone(db: Q, phones: string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  const unique = [...new Set(phones)];
  if (unique.length === 0) return out;
  const res = await sql<{ phone: string; id: string; name: string }>`
    SELECT DISTINCT ON (p.phone) p.phone, g.id, g.first_name || ' ' || g.last_name AS name
      FROM unnest(${unique}::text[]) AS p(phone)
      JOIN guardians g ON g.archived_at IS NULL AND (g.phone_primary = p.phone OR g.phone_secondary = p.phone OR g.whatsapp_number = p.phone)
     ORDER BY p.phone, (g.phone_primary = p.phone) DESC, g.created_at`.execute(db);
  for (const r of res.rows) out.set(r.phone, { id: r.id, name: r.name });
  return out;
}

export async function findStaff(db: Q, codes: string[], phones: string[]): Promise<{ byCode: Map<string, string>; byPhone: Map<string, { id: string; name: string; code: string }> }> {
  const byCode = new Map<string, string>();
  const byPhone = new Map<string, { id: string; name: string; code: string }>();
  if (codes.length) {
    const r = await db.selectFrom('staff').select(['id', 'staff_code']).where(sql<boolean>`upper(staff_code) = ANY (${codes}::text[])`).execute();
    for (const s of r) byCode.set(s.staff_code.toUpperCase(), s.id);
  }
  if (phones.length) {
    const r = await db.selectFrom('staff').select(['id', 'phone', 'first_name', 'last_name', 'staff_code']).where('phone', 'in', phones).where('archived_at', 'is', null).execute();
    for (const s of r) if (s.phone) byPhone.set(s.phone, { id: s.id, name: `${s.first_name} ${s.last_name}`, code: s.staff_code });
  }
  return { byCode, byPhone };
}

export interface BalanceStudent {
  id: string;
  code: string;
  name: string;
}

/** Resolves opening-balance rows to students by new code, or by Old Student ID from an earlier committed student import. */
export async function findBalanceStudents(db: Q, codes: string[], legacyIds: string[]): Promise<{ byCode: Map<string, BalanceStudent>; byLegacy: Map<string, BalanceStudent> }> {
  const byCode = new Map<string, BalanceStudent>();
  const byLegacy = new Map<string, BalanceStudent>();
  if (codes.length) {
    const r = await db.selectFrom('students').select(['id', 'student_code', 'first_name', 'last_name']).where('student_code', 'in', codes).execute();
    for (const s of r) byCode.set(s.student_code, { id: s.id, code: s.student_code, name: `${s.first_name} ${s.last_name}` });
  }
  if (legacyIds.length) {
    const r = await sql<{ legacy: string; id: string; student_code: string; name: string }>`
      SELECT DISTINCT ON (r.normalised->>'legacyId') r.normalised->>'legacyId' AS legacy, s.id, s.student_code, s.first_name || ' ' || s.last_name AS name
        FROM import.rows r JOIN import.jobs j ON j.id = r.job_id AND j.type = 'students_guardians'
        JOIN students s ON s.id = r.target_student_id
       WHERE r.committed_at IS NOT NULL AND r.normalised->>'legacyId' = ANY (${legacyIds}::text[])
       ORDER BY r.normalised->>'legacyId', r.committed_at DESC`.execute(db);
    for (const s of r.rows) byLegacy.set(s.legacy, { id: s.id, code: s.student_code, name: s.name });
  }
  return { byCode, byLegacy };
}

/** Students that already have an opening_balance ledger entry (posting twice would double the debt). */
export async function studentsWithOpeningBalance(db: Q, studentIds: string[]): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const r = await db.selectFrom('ledger_entries').select('student_id').distinct().where('entry_type', '=', 'opening_balance').where('student_id', 'in', studentIds).execute();
  return new Set(r.map((x) => x.student_id));
}
