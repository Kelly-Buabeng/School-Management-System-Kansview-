// Owner: Agent B. Guardians, student links, Ghana Card reveal, merge.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes, normaliseGhanaPhone } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { pageOffset, type Page } from '../../common/pagination';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_CRYPTO, type FieldCrypto } from '../../security/field-crypto';
import { FIELD_POLICY, type FieldPolicy } from '../../security/field-policy';
import { isFkViolation, isoInstant } from '../settings/common/db';
import { parseId, versionConflict } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { escapeLike } from '../search/classify';
import { StudentReader } from '../students/student-reader';
import { normaliseGuardianFlags } from '../students/admission-rules';
import { GuardianWriter } from './guardian-writer';
import type { GuardianInput, GuardianLinkInput, UpdateGuardianBody, UpdateLinkBody } from './guardians.dto';

const COLS: Record<string, string> = {
  title: 'title', firstName: 'first_name', lastName: 'last_name', phonePrimary: 'phone_primary', phoneSecondary: 'phone_secondary',
  whatsappNumber: 'whatsapp_number', email: 'email', occupation: 'occupation', workplace: 'workplace', homeAddress: 'home_address', workAddress: 'work_address',
};

@Injectable()
export class GuardiansService {
  private readonly logger = new Logger('GuardiansService');
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(FIELD_POLICY) private readonly fields: FieldPolicy,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto,
    private readonly access: RecordAccess,
    private readonly reader: StudentReader,
    private readonly writer: GuardianWriter,
  ) {}

  /** Guardian visible to this user (TEACHER: only guardians of students in their classes). 404 otherwise. */
  private async guardianInScope(user: AuthUser, rawId: string, tx?: Tx) {
    const id = parseId(rawId, 'guardian');
    const g = await (tx ?? this.db).selectFrom('guardians').selectAll().where('id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
    if (!g) throw AppError.notFound('guardian');
    const allowed = await this.access.allowedClassIds(user);
    if (allowed) {
      const ok = allowed.length > 0 && await (tx ?? this.db).selectFrom('student_guardians as sg')
        .innerJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 'sg.student_id').on('e.end_date', 'is', null))
        .select('sg.student_id').where('sg.guardian_id', '=', id).where('e.class_id', 'in', allowed).executeTakeFirst();
      if (!ok) throw AppError.notFound('guardian');
    }
    return g;
  }

  private dto(g: { id: string; title: string | null; first_name: string; last_name: string; phone_primary: string; phone_secondary: string | null; whatsapp_number: string | null; email: string | null; occupation: string | null; workplace: string | null; home_address: string | null; work_address: string | null; ghana_card_last4: string | null; version: number; created_at: Date }) {
    return {
      id: g.id, title: g.title, firstName: g.first_name, lastName: g.last_name, fullName: `${g.first_name} ${g.last_name}`,
      phonePrimary: g.phone_primary, phoneSecondary: g.phone_secondary, whatsappNumber: g.whatsapp_number, email: g.email, occupation: g.occupation,
      workplace: g.workplace, homeAddress: g.home_address, workAddress: g.work_address, ghanaCardLast4: g.ghana_card_last4,
      hasGhanaCard: g.ghana_card_last4 !== null, version: g.version, createdAt: isoInstant(g.created_at),
    };
  }

  async list(user: AuthUser, q: { page: number; pageSize: number; q?: string; phone?: string }): Promise<Page<unknown>> {
    const allowed = await this.access.allowedClassIds(user);
    if (allowed && allowed.length === 0) return { data: [], page: q.page, pageSize: q.pageSize, total: 0 };
    let query = this.db.selectFrom('guardians as g').where('g.archived_at', 'is', null);
    if (allowed) {
      query = query.where((eb) => eb.exists(eb.selectFrom('student_guardians as sg')
        .innerJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 'sg.student_id').on('e.end_date', 'is', null))
        .select('sg.student_id').whereRef('sg.guardian_id', '=', 'g.id').where('e.class_id', 'in', allowed)));
    }
    if (q.phone) {
      const p = normaliseGhanaPhone(q.phone);
      const digits = q.phone.replace(/\D/g, '');
      query = p
        ? query.where((eb) => eb.or([eb('g.phone_primary', '=', p), eb('g.phone_secondary', '=', p), eb('g.whatsapp_number', '=', p)]))
        : query.where('g.phone_primary', 'like', `%${escapeLike(digits.slice(-9))}`);
    }
    if (q.q) {
      const t = q.q.toLowerCase();
      query = query.where((eb) => eb.or([
        eb(sql`lower(g.first_name || ' ' || g.last_name)`, 'like', `%${escapeLike(t)}%`),
        eb(sql<number>`similarity(lower(g.first_name || ' ' || g.last_name), ${t})`, '>=', 0.3),
      ]));
    }
    const total = (await query.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n;
    const { limit, offset } = pageOffset(q);
    const rows = await query.selectAll('g')
      .select((eb) => eb.selectFrom('student_guardians as sg').select(sql<number>`count(*)::int`.as('n')).whereRef('sg.guardian_id', '=', 'g.id').as('children_count'))
      .orderBy('g.last_name').orderBy('g.first_name').orderBy('g.id').limit(limit).offset(offset).execute();
    return { data: rows.map((r) => this.fields.apply('guardian', { ...this.dto(r), childrenCount: r.children_count ?? 0 }, user)), page: q.page, pageSize: q.pageSize, total };
  }

  async create(body: GuardianInput, user: AuthUser) {
    const id = await this.db.transaction().execute(async (tx) => {
      const gid = await this.writer.create(tx, body, user.id);
      await this.audit.record({ action: 'create', entityType: 'guardian', entityId: gid, changes: { name: { after: `${body.firstName} ${body.lastName}` }, ...(body.ghanaCardNumber && { ghanaCard: { after: '[saved]' } }) } }, user, tx);
      return gid;
    });
    return this.get(id, user, false);
  }

  async get(rawId: string, user: AuthUser, audit = true) {
    const g = await this.guardianInScope(user, rawId);
    const children = await this.children(g.id, user);
    if (audit) await this.audit.record({ action: 'view', entityType: 'guardian', entityId: g.id }, user);
    return this.fields.apply('guardian', { ...this.dto(g), children }, user);
  }

  async children(guardianId: string, user: AuthUser) {
    const links = await this.db.selectFrom('student_guardians').select(['student_id', 'relationship', 'is_primary', 'is_fee_payer']).where('guardian_id', '=', guardianId).execute();
    const allowed = await this.access.allowedClassIds(user);
    const map = await this.reader.summaries(links.map((l) => l.student_id));
    return links.filter((l) => map.has(l.student_id) && (!allowed || allowed.includes(map.get(l.student_id)!.classId ?? '')))
      .map((l) => ({ ...map.get(l.student_id)!, relationship: l.relationship, isPrimary: l.is_primary, isFeePayer: l.is_fee_payer }));
  }

  async listStudents(rawId: string, user: AuthUser) {
    const g = await this.guardianInScope(user, rawId);
    return this.children(g.id, user);
  }

  async update(rawId: string, body: UpdateGuardianBody, version: number, user: AuthUser) {
    const g = await this.guardianInScope(user, rawId);
    await this.db.transaction().execute(async (tx) => {
      if (g.version !== version) throw versionConflict();
      const set: Record<string, unknown> = {};
      const changes: Record<string, { before?: unknown; after?: unknown }> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || k === 'ghanaCardNumber') continue;
        const col = COLS[k]!;
        set[col] = v;
        const before = (g as Record<string, unknown>)[col];
        if (before !== v) changes[k] = k.endsWith('Address') ? { after: '[changed]' } : { before, after: v };
      }
      Object.assign(set, this.writer.ghanaCardColumns(body.ghanaCardNumber));
      if (body.ghanaCardNumber !== undefined) changes.ghanaCard = { after: body.ghanaCardNumber ? '[changed]' : '[removed]' };
      const r = await tx.updateTable('guardians').set({ ...set, updated_by: user.id }).where('id', '=', g.id).where('version', '=', version).returning('id').executeTakeFirst();
      if (!r) throw versionConflict();
      await this.audit.record({ action: 'update', entityType: 'guardian', entityId: g.id, changes }, user, tx);
    });
    return this.get(g.id, user, false);
  }

  async revealGhanaCard(rawId: string, reason: string, user: AuthUser) {
    const g = await this.guardianInScope(user, rawId);
    if (!g.ghana_card_enc) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No Ghana Card number is saved for this guardian');
    let value: string;
    try {
      value = this.crypto.decrypt(Buffer.from(g.ghana_card_enc));
    } catch (err) {
      this.logger.error({ guardianId: g.id, err: (err as Error).message }, 'ghana card decrypt failed');
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The Ghana Card number could not be read. Tell the administrator.');
    }
    await this.audit.record({ action: 'reveal_sensitive', entityType: 'guardian', entityId: g.id, changes: { field: { after: 'ghana_card' } }, reason }, user);
    return { guardianId: g.id, ghanaCardNumber: value };
  }

  /** Moves all student links, contacts and pickups to `keep`, then archives `merge` (kept for history, pointing to the winner). */
  async merge(body: { keepGuardianId: string; mergeGuardianId: string; reason: string }, user: AuthUser) {
    if (body.keepGuardianId === body.mergeGuardianId) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose two different guardians to merge');
    await this.db.transaction().execute(async (tx) => {
      const keep = await this.guardianInScope(user, body.keepGuardianId, tx);
      const lose = await this.guardianInScope(user, body.mergeGuardianId, tx);
      const loserLinks = await tx.selectFrom('student_guardians').selectAll().where('guardian_id', '=', lose.id).execute();
      const keepLinks = new Set((await tx.selectFrom('student_guardians').select('student_id').where('guardian_id', '=', keep.id).execute()).map((r) => r.student_id));
      for (const l of loserLinks) {
        await tx.deleteFrom('student_guardians').where('student_id', '=', l.student_id).where('guardian_id', '=', lose.id).execute();
        if (!keepLinks.has(l.student_id)) {
          await tx.insertInto('student_guardians').values({ ...l, guardian_id: keep.id, updated_by: user.id, updated_at: sql`now()` }).execute();
        } else if (l.is_primary) {
          await tx.updateTable('student_guardians').set({ is_primary: true }).where('student_id', '=', l.student_id).where('guardian_id', '=', keep.id).execute();
        }
      }
      await tx.updateTable('emergency_contacts').set({ guardian_id: keep.id, updated_by: user.id }).where('guardian_id', '=', lose.id).execute();
      await tx.updateTable('authorised_pickups').set({ guardian_id: keep.id, updated_by: user.id }).where('guardian_id', '=', lose.id).execute();
      await tx.updateTable('guardians').set({ archived_at: sql`now()`, archived_by: user.id, archive_reason: `Merged into ${keep.id}: ${body.reason}`, updated_by: user.id }).where('id', '=', lose.id).execute();
      await this.audit.record({ action: 'update', entityType: 'guardian_merge', entityId: keep.id, changes: { mergedGuardianId: { after: lose.id }, studentsMoved: { after: loserLinks.map((l) => l.student_id) } }, reason: body.reason }, user, tx);
    });
    return this.get(body.keepGuardianId, user, false);
  }

  // ---------------- student links ----------------
  async listForStudent(rawStudentId: string, user: AuthUser) {
    const s = await this.access.student(user, rawStudentId);
    const rows = await this.db.selectFrom('student_guardians as sg').innerJoin('guardians as g', 'g.id', 'sg.guardian_id')
      .selectAll('g').select(['sg.relationship', 'sg.is_primary', 'sg.is_fee_payer', 'sg.can_pick_up', 'sg.receives_sms', 'sg.lives_with_student'])
      .where('sg.student_id', '=', s.id).where('g.archived_at', 'is', null).orderBy('sg.is_primary', 'desc').orderBy('g.last_name').execute();
    return rows.map((r) => this.fields.apply('guardian', {
      ...this.dto(r), relationship: r.relationship, isPrimary: r.is_primary, isFeePayer: r.is_fee_payer, canPickUp: r.can_pick_up,
      receivesSms: r.receives_sms, livesWithStudent: r.lives_with_student,
    }, user));
  }

  async link(rawStudentId: string, body: GuardianLinkInput, user: AuthUser) {
    const s = await this.access.student(user, rawStudentId);
    await this.db.transaction().execute(async (tx) => {
      const existing = await tx.selectFrom('student_guardians').select(['guardian_id', 'is_primary']).where('student_id', '=', s.id).execute();
      if (body.guardianId && existing.some((e) => e.guardian_id === body.guardianId)) {
        throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'This guardian is already linked to the student');
      }
      if (body.guardianId) await this.writer.assertExists(tx, body.guardianId);
      const gid = body.guardianId ?? (await this.writer.create(tx, body.newGuardian!, user.id));
      const [flags] = normaliseGuardianFlags([{ ...body, isPrimary: body.isPrimary ?? existing.length === 0 }]);
      await this.writer.link(tx, s.id, gid, { ...flags!, relationship: body.relationship, isFeePayer: body.isFeePayer ?? false }, user.id);
      await this.audit.record({ action: 'update', entityType: 'student_guardian', entityId: gid, studentId: s.id, changes: { linked: { after: gid }, relationship: { after: body.relationship } } }, user, tx);
    });
    return this.listForStudent(s.id, user);
  }

  async updateLink(rawStudentId: string, rawGuardianId: string, body: UpdateLinkBody, user: AuthUser) {
    const s = await this.access.student(user, rawStudentId);
    const gid = parseId(rawGuardianId, 'guardian');
    await this.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('student_guardians').selectAll().where('student_id', '=', s.id).where('guardian_id', '=', gid).executeTakeFirst();
      if (!cur) throw AppError.notFound('guardian link');
      await this.writer.link(tx, s.id, gid, {
        relationship: body.relationship ?? cur.relationship, isPrimary: body.isPrimary ?? cur.is_primary, isFeePayer: body.isFeePayer ?? cur.is_fee_payer,
        canPickUp: body.canPickUp ?? cur.can_pick_up, receivesSms: body.receivesSms ?? cur.receives_sms, livesWithStudent: body.livesWithStudent ?? cur.lives_with_student,
      }, user.id);
      const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, { after: v }]));
      await this.audit.record({ action: 'update', entityType: 'student_guardian', entityId: gid, studentId: s.id, changes }, user, tx);
    });
    return this.listForStudent(s.id, user);
  }

  async unlink(rawStudentId: string, rawGuardianId: string, user: AuthUser) {
    const s = await this.access.student(user, rawStudentId);
    const gid = parseId(rawGuardianId, 'guardian');
    await this.db.transaction().execute(async (tx) => {
      const links = await tx.selectFrom('student_guardians').select('guardian_id').where('student_id', '=', s.id).execute();
      if (!links.some((l) => l.guardian_id === gid)) throw AppError.notFound('guardian link');
      if (links.length === 1) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'A student must keep at least one guardian', 'Link another guardian first.');
      const used = await tx.selectFrom('emergency_contacts').select('id').where('student_id', '=', s.id).where('guardian_id', '=', gid).executeTakeFirst();
      if (used) await tx.deleteFrom('emergency_contacts').where('id', '=', used.id).execute();
      try {
        await tx.deleteFrom('student_guardians').where('student_id', '=', s.id).where('guardian_id', '=', gid).execute();
      } catch (e) {
        if (isFkViolation(e)) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'This guardian is still used on the student record');
        throw e;
      }
      await this.audit.record({ action: 'update', entityType: 'student_guardian', entityId: gid, studentId: s.id, changes: { unlinked: { before: gid } } }, user, tx);
    });
  }
}

