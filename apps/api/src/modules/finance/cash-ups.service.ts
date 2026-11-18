import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes, todayInAccra } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { expectedByMethod, variance, type ByMethod, type PaymentMethod } from './domain';
import { toIso } from './finance-store';
import { isUniqueViolation } from './support';

@Injectable()
export class CashUpsService {
  constructor(@Inject(KYSELY) private readonly db: Db, @Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  /** Payments taken on a business day (Accra date of received_at), plus any explicitly linked to the cash-up. */
  async paymentsFor(db: Db | Tx, businessDate: string, cashUpId?: string) {
    return db.selectFrom('payments').select(['id', 'receipt_no', 'method', 'amount_pesewas', 'status', 'received_at', 'reference_no', 'student_id'])
      .where((eb) => eb.or([
        eb(sql<string>`(received_at at time zone 'Africa/Accra')::date`, '=', businessDate),
        ...(cashUpId ? [eb('cash_up_id', '=', cashUpId)] : []),
      ]))
      .orderBy('receipt_no').execute();
  }

  async expected(db: Db | Tx, businessDate: string, cashUpId?: string): Promise<ByMethod> {
    const ps = await this.paymentsFor(db, businessDate, cashUpId);
    return expectedByMethod(ps.map((p) => ({ method: p.method as PaymentMethod, amountPesewas: Number(p.amount_pesewas), status: p.status })));
  }

  async open(body: { businessDate?: string; notes?: string }, user: AuthUser) {
    const date = body.businessDate ?? todayInAccra();
    try {
      return await this.db.transaction().execute(async (tx) => {
        const row = await tx.insertInto('cash_ups').values({ business_date: date, opened_by: user.id, notes: body.notes ?? null, status: 'open', created_by: user.id, updated_by: user.id })
          .returning('id').executeTakeFirstOrThrow();
        await tx.updateTable('payments').set({}).where(sql<boolean>`false`).execute(); // no-op: payments are never edited to link; linking happens at recording time
        await this.audit.record({ action: 'create', entityType: 'cash_up', entityId: row.id, changes: { businessDate: { after: date } } }, user, tx);
        return this.view(tx, row.id);
      });
    } catch (e) {
      if (isUniqueViolation(e, 'cash_ups_business_date_key')) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, `A cash-up for ${date} already exists`);
      if (isUniqueViolation(e, 'cash_ups_one_open')) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'Another cash-up is still open', 'Close it before opening a new one.');
      throw e;
    }
  }

  async close(id: string, counted: Partial<ByMethod>, notes: string | undefined, user: AuthUser) {
    return this.db.transaction().execute(async (tx) => {
      const cu = await tx.selectFrom('cash_ups').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cu) throw AppError.notFound('cash-up');
      if (cu.status !== 'open') throw new AppError(409, ErrorCodes.CASH_UP_CLOSED, 'This cash-up is already closed');
      const exp = await this.expected(tx, String(cu.business_date), id);
      const v = variance(exp, counted);
      const countedFull = Object.fromEntries(Object.keys(exp).map((m) => [m, counted[m as PaymentMethod] ?? 0]));
      await tx.updateTable('cash_ups').set({
        status: 'closed', closed_by: user.id, closed_at: new Date(), expected_by_method: exp, counted_by_method: countedFull,
        variance_pesewas: v.totalPesewas, notes: notes ?? cu.notes, updated_by: user.id,
      }).where('id', '=', id).execute();
      await this.audit.record({ action: 'update', entityType: 'cash_up', entityId: id, changes: { status: { before: 'open', after: 'closed' }, variancePesewas: { after: v.totalPesewas } }, reason: notes ?? null }, user, tx);
      return this.view(tx, id);
    });
  }

  async list() {
    const rows = await this.db.selectFrom('cash_ups').select('id').orderBy('business_date', 'desc').limit(200).execute();
    return { data: await Promise.all(rows.map((r) => this.view(this.db, r.id))) };
  }

  async get(id: string) {
    return this.view(this.db, id);
  }

  async view(db: Db | Tx, id: string) {
    const cu = await db.selectFrom('cash_ups').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cu) throw AppError.notFound('cash-up');
    const date = String(cu.business_date);
    const exp = cu.status === 'closed' && cu.expected_by_method ? (cu.expected_by_method as ByMethod) : await this.expected(db, date, id);
    const ps = await this.paymentsFor(db, date, id);
    const expectedTotal = Object.values(exp).reduce((a, b) => a + b, 0);
    return {
      id: cu.id, businessDate: date, status: cu.status, openedBy: cu.opened_by, openedAt: toIso(cu.opened_at), closedBy: cu.closed_by,
      closedAt: cu.closed_at ? toIso(cu.closed_at) : null, notes: cu.notes,
      expectedByMethod: exp, expectedTotalPesewas: expectedTotal,
      countedByMethod: (cu.counted_by_method as ByMethod | null) ?? null,
      variancePesewas: cu.variance_pesewas === null ? null : Number(cu.variance_pesewas),
      varianceByMethod: cu.counted_by_method ? variance(exp, cu.counted_by_method as ByMethod).byMethod : null,
      paymentCount: ps.filter((p) => p.status === 'confirmed').length,
      reversedCount: ps.filter((p) => p.status === 'reversed').length,
    };
  }
}
