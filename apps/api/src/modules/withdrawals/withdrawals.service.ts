// Owner: Agent B. Withdrawals and transfers: clearance checklist, completion, transfer letter (PDF via Agent F).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { LEDGER_SERVICE, PDF_SERVICE, type LedgerService, type PdfService } from '../../common/contracts';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { fullNameSql, isUniqueViolation, isoInstant } from '../settings/common/db';
import { parseId, zDate } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';
import { SettingsService } from '../settings/settings.service';
import { canSetItem, CLEARANCE_ITEMS, CLEARANCE_LABELS, isFullyCleared, outstandingItems, readClearance, emptyClearance, type ClearanceItem } from './clearance';

export const StartWithdrawalBody = z.strictObject({
  type: z.enum(['withdrawal', 'transfer_out']),
  reason: z.string().trim().min(3).max(500),
  effectiveDate: zDate,
  destinationSchool: z.string().trim().max(150).optional(),
});
export const ClearanceBody = z.strictObject({
  cleared: z.boolean(),
  notApplicable: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
});
export const ListWithdrawalsQuery = z.strictObject({ status: z.enum(['pending_clearance', 'completed', 'cancelled']).optional() });
export const CancelBody = z.strictObject({ reason: z.string().trim().max(300).optional() });

@Injectable()
export class WithdrawalsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(LEDGER_SERVICE) private readonly ledger: LedgerService,
    @Inject(PDF_SERVICE) private readonly pdf: PdfService,
    private readonly access: RecordAccess,
    private readonly settings: SettingsService,
  ) {}

  private query(db: Db | Tx = this.db) {
    return db.selectFrom('withdrawals as w').innerJoin('students as s', 's.id', 'w.student_id')
      .leftJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 's.id').on('e.end_date', 'is', null))
      .leftJoin('classes as c', 'c.id', 'e.class_id')
      .selectAll('w').select(['s.student_code', fullNameSql('s').as('student_name'), 'c.display_name as class_name']);
  }

  private async dto(r: Awaited<ReturnType<ReturnType<WithdrawalsService['query']>['executeTakeFirstOrThrow']>>, withBalance: boolean) {
    const clearance = readClearance(r.clearance);
    const balance = withBalance ? await this.ledger.balance(r.student_id) : null;
    return {
      id: r.id, studentId: r.student_id, studentCode: r.student_code, studentName: r.student_name, className: r.class_name, type: r.type, reason: r.reason,
      effectiveDate: r.effective_date, destinationSchool: r.destination_school, status: r.status, letterNo: r.letter_no,
      clearance: CLEARANCE_ITEMS.map((i) => ({ item: i, label: CLEARANCE_LABELS[i], ...clearance[i] })),
      outstandingItems: outstandingItems(clearance), fullyCleared: isFullyCleared(clearance),
      feeBalancePesewas: balance?.balancePesewas ?? null, completedAt: isoInstant(r.completed_at), createdAt: isoInstant(r.created_at), version: r.version,
    };
  }

  private async load(user: AuthUser, rawId: string, tx?: Tx) {
    const id = parseId(rawId, 'withdrawal');
    const r = await this.query(tx).where('w.id', '=', id).executeTakeFirst();
    if (!r) throw AppError.notFound('withdrawal');
    await this.access.student(user, r.student_id, { includeArchived: true, tx });
    return r;
  }

  async list(user: AuthUser, q: z.infer<typeof ListWithdrawalsQuery>) {
    let query = this.query();
    if (q.status) query = query.where('w.status', '=', q.status);
    const rows = await query.orderBy('w.created_at', 'desc').limit(500).execute();
    return Promise.all(rows.map((r) => this.dto(r, false)));
  }

  async get(rawId: string, user: AuthUser) {
    return this.dto(await this.load(user, rawId), user.permissions.has('balances:read'));
  }

  async start(rawStudentId: string, body: z.infer<typeof StartWithdrawalBody>, user: AuthUser) {
    const s = await this.access.student(user, rawStudentId);
    if (s.status !== 'active') throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Only active students can be withdrawn');
    try {
      const id = await this.db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('withdrawals').values({
          student_id: s.id, type: body.type, reason: body.reason, effective_date: body.effectiveDate, destination_school: body.destinationSchool ?? null,
          clearance: JSON.stringify(emptyClearance()), status: 'pending_clearance', created_by: user.id, updated_by: user.id,
        }).returning('id').executeTakeFirstOrThrow();
        await this.audit.record({ action: 'create', entityType: 'withdrawal', entityId: r.id, studentId: s.id, changes: { type: { after: body.type } }, reason: body.reason }, user, tx);
        return r.id;
      });
      return this.dto(await this.load(user, id), user.permissions.has('balances:read') || user.permissions.has('withdrawals:update'));
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'This student already has a withdrawal waiting for clearance');
      throw e;
    }
  }

  async setClearance(rawId: string, rawItem: string, body: z.infer<typeof ClearanceBody>, user: AuthUser) {
    if (!(CLEARANCE_ITEMS as readonly string[]).includes(rawItem)) throw AppError.notFound('clearance item');
    const item = rawItem as ClearanceItem;
    if (!canSetItem(item, user)) throw new AppError(403, ErrorCodes.FORBIDDEN, 'Only the bursar or an administrator can clear fees');
    await this.db.transaction().execute(async (tx) => {
      const w = await this.load(user, rawId, tx);
      if (w.status !== 'pending_clearance') throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'This withdrawal is already closed');
      const c = readClearance(w.clearance);
      const balance = item === 'fees' ? (await this.ledger.balance(w.student_id, tx)).balancePesewas : undefined;
      c[item] = { cleared: body.cleared, notApplicable: body.notApplicable ?? false, note: body.note ?? null, byUserId: user.id, byName: user.fullName, at: new Date().toISOString(), ...(balance !== undefined && { balancePesewas: balance }) };
      await tx.updateTable('withdrawals').set({ clearance: JSON.stringify(c), updated_by: user.id }).where('id', '=', w.id).execute();
      await this.audit.record({ action: 'update', entityType: 'withdrawal', entityId: w.id, studentId: w.student_id, changes: { [`clearance.${item}`]: { after: body.cleared }, ...(balance !== undefined && { feeBalancePesewas: { after: balance } }) } }, user, tx);
    });
    return this.get(rawId, user);
  }

  /** All items cleared → student status changes, the open enrolment closes. */
  async complete(rawId: string, user: AuthUser) {
    await this.db.transaction().execute(async (tx) => {
      const w = await this.load(user, rawId, tx);
      if (w.status !== 'pending_clearance') throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'This withdrawal is already closed');
      const c = readClearance(w.clearance);
      if (!isFullyCleared(c)) {
        throw new AppError(422, ErrorCodes.WITHDRAWAL_NOT_CLEARED, 'Clearance is not finished', `Still outstanding: ${outstandingItems(c).map((i) => CLEARANCE_LABELS[i]).join(', ')}.`, undefined, { outstandingItems: outstandingItems(c) });
      }
      const st = await tx.selectFrom('students').select('status').where('id', '=', w.student_id).forUpdate().executeTakeFirstOrThrow();
      const to = w.type === 'transfer_out' ? 'transferred_out' : 'withdrawn';
      await tx.updateTable('enrolments').set({ end_date: sql`greatest(start_date, ${w.effective_date}::date)`, status: 'withdrawn', reason: w.type === 'transfer_out' ? `Transferred to ${w.destination_school ?? 'another school'}` : `Withdrawn: ${w.reason}`, updated_by: user.id })
        .where('student_id', '=', w.student_id).where('end_date', 'is', null).execute();
      await tx.updateTable('students').set({ status: to, updated_by: user.id }).where('id', '=', w.student_id).execute();
      await tx.insertInto('student_status_history').values({ student_id: w.student_id, from_status: st.status, to_status: to, effective_date: w.effective_date, reason: w.reason, source: 'withdrawal', source_ref_id: w.id, created_by: user.id }).execute();
      await tx.updateTable('withdrawals').set({ status: 'completed', completed_at: sql`now()`, completed_by: user.id, updated_by: user.id }).where('id', '=', w.id).execute();
      await this.audit.record({ action: 'update', entityType: 'withdrawal', entityId: w.id, studentId: w.student_id, changes: { status: { before: 'pending_clearance', after: 'completed' }, studentStatus: { before: st.status, after: to } } }, user, tx);
    });
    return this.get(rawId, user);
  }

  async cancel(rawId: string, reason: string | undefined, user: AuthUser) {
    await this.db.transaction().execute(async (tx) => {
      const w = await this.load(user, rawId, tx);
      if (w.status !== 'pending_clearance') throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Only a pending withdrawal can be cancelled');
      await tx.updateTable('withdrawals').set({ status: 'cancelled', updated_by: user.id }).where('id', '=', w.id).execute();
      await this.audit.record({ action: 'update', entityType: 'withdrawal', entityId: w.id, studentId: w.student_id, changes: { status: { before: 'pending_clearance', after: 'cancelled' } }, reason: reason ?? null }, user, tx);
    });
    return this.get(rawId, user);
  }

  /** Letter number is assigned once (gap-free counter, in its own transaction) and reused for reprints. */
  async transferLetter(rawId: string, user: AuthUser): Promise<{ pdf: Buffer; letterNo: string }> {
    const w = await this.load(user, rawId);
    if (w.type !== 'transfer_out' || w.status !== 'completed') throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'A transfer letter is available once a transfer is completed');
    const letterNo = await this.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('withdrawals').select('letter_no').where('id', '=', w.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.letter_no) return cur.letter_no;
      const no = (await sql<{ n: string }>`SELECT app.next_doc_no('transfer_letter') AS n`.execute(tx)).rows[0]!.n;
      await tx.updateTable('withdrawals').set({ letter_no: no, updated_by: user.id }).where('id', '=', w.id).execute();
      return no;
    });
    const school = await this.settings.getSchoolProfile();
    const s = await this.db.selectFrom('students as s').select(['s.student_code', fullNameSql('s').as('name'), 's.date_of_birth', 's.gender', 's.admission_date']).where('s.id', '=', w.student_id).executeTakeFirstOrThrow();
    const last = await this.db.selectFrom('enrolments as e').innerJoin('classes as c', 'c.id', 'e.class_id').select(['c.display_name', 'e.end_date']).where('e.student_id', '=', w.student_id).orderBy('e.start_date', 'desc').limit(1).executeTakeFirst();
    const pdf = await this.pdf.render('transfer_letter', {
      letterNo, issuedOn: todayInAccra(), school: { name: school.name, address: school.address, phone: school.phone, email: school.email, motto: school.motto, logoFileId: school.logoFileId },
      student: { studentCode: s.student_code, fullName: s.name, dateOfBirth: s.date_of_birth, gender: s.gender, admissionDate: s.admission_date, lastClass: last?.display_name ?? null },
      effectiveDate: w.effective_date, destinationSchool: w.destination_school, reason: w.reason, signedBy: user.fullName,
    });
    await this.audit.record({ action: 'export', entityType: 'transfer_letter', entityId: w.id, studentId: w.student_id, changes: { letterNo: { after: letterNo } } }, user);
    return { pdf, letterNo };
  }
}
