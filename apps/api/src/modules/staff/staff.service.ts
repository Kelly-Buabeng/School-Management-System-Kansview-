// Owner: Agent B. Staff records, emergency contacts, class assignments (drive TEACHER scope), sensitive reveal.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { PageQuery, pageOffset } from '../../common/pagination';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_CRYPTO, type FieldCrypto } from '../../security/field-crypto';
import { FIELD_POLICY, type FieldPolicy } from '../../security/field-policy';
import { isUniqueViolation, isoInstant } from '../settings/common/db';
import { parseId, versionConflict, zDate, zGhanaPhone, zUuid } from '../settings/common/http';
import { escapeLike } from '../search/classify';
import { zGhanaCard } from '../guardians/guardians.dto';

const base = {
  title: z.string().trim().max(20),
  firstName: z.string().trim().min(1).max(80),
  middleNames: z.string().trim().max(120),
  lastName: z.string().trim().min(1).max(80),
  gender: z.enum(['male', 'female']),
  dateOfBirth: zDate,
  phone: zGhanaPhone,
  email: z.string().trim().email().max(150),
  address: z.string().trim().max(300),
  staffType: z.enum(['teaching', 'non_teaching']),
  jobTitle: z.string().trim().max(100),
  employmentDate: zDate,
  status: z.enum(['active', 'on_leave', 'left']),
  ghanaCardNumber: zGhanaCard,
  ssnitNo: z.string().trim().regex(/^[A-Z0-9]{8,15}$/i, 'SSNIT numbers are 8–15 letters/digits'),
};
export const CreateStaffBody = z.strictObject({
  ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, ['firstName', 'lastName', 'staffType'].includes(k) ? v : (v as z.ZodTypeAny).optional()])),
}) as unknown as z.ZodType<{ firstName: string; lastName: string; staffType: 'teaching' | 'non_teaching' } & Partial<Record<Exclude<keyof typeof base, 'firstName' | 'lastName' | 'staffType'>, string>>>;
export const UpdateStaffBody = z.strictObject(
  Object.fromEntries(Object.entries(base).map(([k, v]) => [k, (v as z.ZodTypeAny).nullable().optional()])),
) as unknown as z.ZodType<Partial<Record<keyof typeof base, string | null>>>;
export const ListStaffQuery = PageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['active', 'on_leave', 'left']).optional(), staffType: z.enum(['teaching', 'non_teaching']).optional() });
export const StaffContactsBody = z.array(z.strictObject({ name: z.string().trim().min(1).max(120), relationship: z.string().trim().max(60).optional(), phone: zGhanaPhone })).max(5);
export const AssignmentsBody = z.array(z.strictObject({
  classId: zUuid, subjectId: zUuid.nullable().optional(), role: z.enum(['class_teacher', 'subject_teacher', 'assistant']),
})).max(60);
export const RevealBody = z.strictObject({ reason: z.string().trim().min(5).max(300), fields: z.array(z.enum(['ghanaCard', 'ssnit'])).min(1).default(['ghanaCard', 'ssnit']) });

const COLS: Record<string, string> = {
  title: 'title', firstName: 'first_name', middleNames: 'middle_names', lastName: 'last_name', gender: 'gender', dateOfBirth: 'date_of_birth', phone: 'phone',
  email: 'email', address: 'address', staffType: 'staff_type', jobTitle: 'job_title', employmentDate: 'employment_date', status: 'status',
};

@Injectable()
export class StaffService {
  private readonly logger = new Logger('StaffService');
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(FIELD_POLICY) private readonly fields: FieldPolicy,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto,
  ) {}

  private dto(r: { id: string; staff_code: string; title: string | null; first_name: string; middle_names: string | null; last_name: string; gender: string | null; date_of_birth: string | null; phone: string | null; email: string | null; address: string | null; staff_type: string; job_title: string | null; employment_date: string | null; status: string; ghana_card_enc: unknown; ssnit_no_enc: unknown; user_id: string | null; version: number; archived_at: Date | null }) {
    return {
      id: r.id, staffCode: r.staff_code, title: r.title, firstName: r.first_name, middleNames: r.middle_names, lastName: r.last_name,
      fullName: [r.title, r.first_name, r.last_name].filter(Boolean).join(' '), gender: r.gender, dateOfBirth: r.date_of_birth, phone: r.phone, email: r.email,
      address: r.address, staffType: r.staff_type, jobTitle: r.job_title, employmentDate: r.employment_date, status: r.status,
      hasGhanaCard: !!r.ghana_card_enc, hasSsnit: !!r.ssnit_no_enc, userId: r.user_id, version: r.version, archivedAt: isoInstant(r.archived_at),
    };
  }

  private async load(rawId: string, tx?: Tx) {
    const r = await (tx ?? this.db).selectFrom('staff').selectAll().where('id', '=', parseId(rawId, 'staff member')).where('archived_at', 'is', null).executeTakeFirst();
    if (!r) throw AppError.notFound('staff member');
    return r;
  }

  async list(user: AuthUser, q: z.infer<typeof ListStaffQuery>) {
    let query = this.db.selectFrom('staff').where('archived_at', 'is', null);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.staffType) query = query.where('staff_type', '=', q.staffType);
    if (q.q) query = query.where(sql`lower(first_name || ' ' || last_name || ' ' || staff_code)`, 'like', `%${escapeLike(q.q.toLowerCase())}%`);
    const total = (await query.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n;
    const { limit, offset } = pageOffset(q);
    const rows = await query.selectAll().orderBy('last_name').orderBy('first_name').orderBy('id').limit(limit).offset(offset).execute();
    return { data: rows.map((r) => this.fields.apply('staff', this.dto(r), user)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(rawId: string, user: AuthUser) {
    const r = await this.load(rawId);
    const contacts = await this.db.selectFrom('staff_emergency_contacts').select(['priority', 'name', 'relationship', 'phone']).where('staff_id', '=', r.id).orderBy('priority').execute();
    return this.fields.apply('staff', { ...this.dto(r), emergencyContacts: contacts, assignments: await this.assignments(r.id) }, user);
  }

  private encryptOrNull(v: string | null | undefined) {
    return v === undefined ? undefined : v === null ? null : this.crypto.encrypt(v);
  }

  async create(body: z.infer<typeof CreateStaffBody>, user: AuthUser) {
    const id = await this.db.transaction().execute(async (tx) => {
      const seq = (await sql<{ v: number }>`INSERT INTO app.id_counters AS c (scope, last_value) VALUES ('staff', 1)
        ON CONFLICT (scope) DO UPDATE SET last_value = c.last_value + 1, updated_at = now() RETURNING c.last_value AS v`.execute(tx)).rows[0]!.v;
      const values: Record<string, unknown> = { staff_code: `STF-${String(seq).padStart(4, '0')}`, created_by: user.id, updated_by: user.id };
      for (const [k, v] of Object.entries(body)) if (COLS[k] && v !== undefined) values[COLS[k]!] = v;
      if (body.ghanaCardNumber) values.ghana_card_enc = this.crypto.encrypt(body.ghanaCardNumber);
      if (body.ssnitNo) values.ssnit_no_enc = this.crypto.encrypt(body.ssnitNo.toUpperCase());
      const r = await tx.insertInto('staff').values(values as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'staff', entityId: r.id, changes: { staffCode: { after: values.staff_code } } }, user, tx);
      return r.id;
    });
    return this.get(id, user);
  }

  async update(rawId: string, body: z.infer<typeof UpdateStaffBody>, version: number, user: AuthUser) {
    const r = await this.load(rawId);
    if (r.version !== version) throw versionConflict();
    await this.db.transaction().execute(async (tx) => {
      const set: Record<string, unknown> = { updated_by: user.id };
      const changes: Record<string, { before?: unknown; after?: unknown }> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (k === 'ghanaCardNumber') { set.ghana_card_enc = this.encryptOrNull(v); changes.ghanaCard = { after: '[changed]' }; continue; }
        if (k === 'ssnitNo') { set.ssnit_no_enc = this.encryptOrNull(v?.toUpperCase() ?? null); changes.ssnit = { after: '[changed]' }; continue; }
        if ((k === 'firstName' || k === 'lastName' || k === 'staffType') && v === null) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, `${k} cannot be empty`);
        set[COLS[k]!] = v;
        changes[k] = { before: (r as Record<string, unknown>)[COLS[k]!], after: v };
      }
      const u = await tx.updateTable('staff').set(set as never).where('id', '=', r.id).where('version', '=', version).returning('id').executeTakeFirst();
      if (!u) throw versionConflict();
      await this.audit.record({ action: 'update', entityType: 'staff', entityId: r.id, changes }, user, tx);
    });
    return this.get(r.id, user);
  }

  async archive(rawId: string, reason: string, user: AuthUser) {
    const r = await this.load(rawId);
    await this.db.transaction().execute(async (tx) => {
      const today = todayInAccra();
      await tx.updateTable('staff').set({ archived_at: sql`now()`, archived_by: user.id, archive_reason: reason, status: 'left', updated_by: user.id }).where('id', '=', r.id).execute();
      await tx.updateTable('staff_class_assignments').set({ end_date: sql`greatest(start_date, ${today}::date)`, updated_by: user.id }).where('staff_id', '=', r.id).where('end_date', 'is', null).execute();
      await tx.updateTable('classes').set({ class_teacher_staff_id: null, updated_by: user.id }).where('class_teacher_staff_id', '=', r.id).execute();
      await this.audit.record({ action: 'archive', entityType: 'staff', entityId: r.id, reason }, user, tx);
    });
  }

  async replaceContacts(rawId: string, contacts: z.infer<typeof StaffContactsBody>, user: AuthUser) {
    const r = await this.load(rawId);
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('staff_emergency_contacts').where('staff_id', '=', r.id).execute();
      if (contacts.length) await tx.insertInto('staff_emergency_contacts').values(contacts.map((c, i) => ({ staff_id: r.id, priority: i + 1, name: c.name, relationship: c.relationship ?? null, phone: c.phone, created_by: user.id, updated_by: user.id }))).execute();
      await this.audit.record({ action: 'update', entityType: 'staff_emergency_contacts', entityId: r.id, changes: { count: { after: contacts.length } } }, user, tx);
    });
    return this.get(r.id, user);
  }

  async assignments(staffId: string, tx?: Tx) {
    const rows = await (tx ?? this.db).selectFrom('staff_class_assignments as a').innerJoin('classes as c', 'c.id', 'a.class_id').leftJoin('subjects as s', 's.id', 'a.subject_id')
      .select(['a.id', 'a.class_id', 'c.display_name', 'c.academic_year_id', 'a.subject_id', 's.name as subject_name', 'a.role', 'a.start_date'])
      .where('a.staff_id', '=', staffId).where('a.end_date', 'is', null).orderBy('c.display_name').execute();
    return rows.map((r) => ({ id: r.id, classId: r.class_id, className: r.display_name, academicYearId: r.academic_year_id, subjectId: r.subject_id, subjectName: r.subject_name, role: r.role, startDate: r.start_date }));
  }

  async listAssignments(rawId: string) {
    const r = await this.load(rawId);
    return this.assignments(r.id);
  }

  /** Replaces the current assignments: removed ones are ended today (history kept), new ones start today. */
  async replaceAssignments(rawId: string, list: z.infer<typeof AssignmentsBody>, user: AuthUser) {
    const r = await this.load(rawId);
    const key = (a: { classId: string; subjectId?: string | null; role: string }) => `${a.classId}|${a.subjectId ?? ''}|${a.role}`;
    try {
      await this.db.transaction().execute(async (tx) => {
        const today = todayInAccra();
        const current = await this.assignments(r.id, tx);
        const wanted = new Set(list.map(key));
        const keep = new Set(current.map(key));
        for (const c of current) if (!wanted.has(key(c))) {
          await tx.updateTable('staff_class_assignments').set({ end_date: sql`greatest(start_date, ${today}::date)`, updated_by: user.id }).where('id', '=', c.id).execute();
          if (c.role === 'class_teacher') await tx.updateTable('classes').set({ class_teacher_staff_id: null }).where('id', '=', c.classId).where('class_teacher_staff_id', '=', r.id).execute();
        }
        for (const a of list) if (!keep.has(key(a))) {
          if (a.role === 'subject_teacher' && !a.subjectId) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose the subject for a subject teacher');
          await tx.insertInto('staff_class_assignments').values({ staff_id: r.id, class_id: a.classId, subject_id: a.subjectId ?? null, role: a.role, start_date: today, created_by: user.id, updated_by: user.id }).execute();
          if (a.role === 'class_teacher') await tx.updateTable('classes').set({ class_teacher_staff_id: r.id, updated_by: user.id }).where('id', '=', a.classId).execute();
        }
        await this.audit.record({ action: 'update', entityType: 'staff_assignments', entityId: r.id, changes: { assignments: { before: current.map(key), after: list.map(key) } } }, user, tx);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'One of these classes already has a class teacher');
      throw e;
    }
    return this.assignments(r.id);
  }

  async reveal(rawId: string, body: z.infer<typeof RevealBody>, user: AuthUser) {
    const r = await this.load(rawId);
    const dec = (b: Buffer | null) => {
      if (!b) return null;
      try { return this.crypto.decrypt(Buffer.from(b)); } catch (err) {
        this.logger.error({ staffId: r.id, err: (err as Error).message }, 'staff sensitive decrypt failed');
        throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'This value could not be read. Tell the administrator.');
      }
    };
    const out: { staffId: string; ghanaCardNumber?: string | null; ssnitNo?: string | null } = { staffId: r.id };
    if (body.fields.includes('ghanaCard')) out.ghanaCardNumber = dec(r.ghana_card_enc);
    if (body.fields.includes('ssnit')) out.ssnitNo = dec(r.ssnit_no_enc);
    await this.audit.record({ action: 'reveal_sensitive', entityType: 'staff', entityId: r.id, changes: { fields: { after: body.fields } }, reason: body.reason }, user);
    return out;
  }
}
