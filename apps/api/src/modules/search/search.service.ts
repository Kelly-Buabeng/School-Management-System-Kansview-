// Owner: Agent B. Global search box: students, guardians, staff, receipts. Each group only for users who may read it,
// and each runs one small indexed query (trigram/prefix/equality). Target p95 < 300 ms at 1,000 students.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { KYSELY, type Db } from '../../common/db/database.module';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_POLICY, type FieldPolicy } from '../../security/field-policy';
import { fullNameSql } from '../settings/common/db';
import { RecordAccess } from '../settings/common/record-access';
import { StudentReader } from '../students/student-reader';
import { classifyQuery, escapeLike } from './classify';

export const SearchQuery = z.strictObject({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

@Injectable()
export class SearchService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(FIELD_POLICY) private readonly fields: FieldPolicy,
    private readonly access: RecordAccess,
    private readonly reader: StudentReader,
  ) {}

  async search(user: AuthUser, q: z.infer<typeof SearchQuery>) {
    const c = classifyQuery(q.q);
    const allowed = await this.access.allowedClassIds(user);
    const [students, guardians, staff, receipts] = await Promise.all([
      user.permissions.has('students:read') ? this.students(c, q.limit, allowed) : [],
      user.permissions.has('guardians:read') ? this.guardians(c, q.limit, allowed) : [],
      user.permissions.has('staff:read') ? this.staff(c, q.limit) : [],
      user.permissions.has('payments:read') && (c.receiptPrefix || c.digits) ? this.receipts(c, q.limit) : [],
    ]);
    return { query: c.text, students, guardians: guardians.map((g) => this.fields.apply('guardian', g, user)), staff: staff.map((s) => this.fields.apply('staff', s, user)), receipts };
  }

  private async students(c: ReturnType<typeof classifyQuery>, limit: number, allowed: string[] | null) {
    if (allowed && allowed.length === 0) return [];
    const text = c.text.toLowerCase();
    const nameExpr = sql`lower(s.first_name || ' ' || coalesce(s.middle_names || ' ', '') || s.last_name)`;
    let q = this.reader.base().select(this.reader.summaryColumns()).where('s.archived_at', 'is', null);
    if (allowed) q = q.where('e.class_id', 'in', allowed);
    if (c.codePrefix) {
      q = q.where('s.student_code', 'like', `${escapeLike(c.codePrefix)}%`).orderBy('s.student_code');
    } else if (c.classLike) {
      q = q.innerJoin('levels as l', 'l.id', 'c.level_id')
        .where((eb) => eb.or([eb(sql`upper(l.code || coalesce(c.stream, ''))`, '=', c.classLike), eb(sql`upper(l.code)`, '=', c.classLike)]))
        .orderBy('c.display_name').orderBy('e.roll_number');
    } else {
      // `%` uses the trigram GIN index on the full-name expression; LIKE catches short fragments of one name.
      q = q.where((eb) => eb.or([
        sql<boolean>`${nameExpr} % ${text}`,
        eb(nameExpr, 'like', `%${escapeLike(text)}%`),
        eb(sql`lower(s.preferred_name)`, '=', text),
      ])).orderBy(sql`similarity(${nameExpr}, ${text})`, 'desc').orderBy('s.last_name');
    }
    const rows = await q.limit(limit).execute();
    return rows.map((r) => this.reader.toSummary(r));
  }

  private async guardians(c: ReturnType<typeof classifyQuery>, limit: number, allowed: string[] | null) {
    if (allowed && allowed.length === 0) return [];
    if (c.codePrefix || c.receiptPrefix || c.classLike) return [];
    let q = this.db.selectFrom('guardians as g').where('g.archived_at', 'is', null)
      .select((eb) => ['g.id', sql<string>`g.first_name || ' ' || g.last_name`.as('full_name'), 'g.phone_primary',
        eb.selectFrom('student_guardians as sg').select(sql<number>`count(*)::int`.as('n')).whereRef('sg.guardian_id', '=', 'g.id').as('children_count')]);
    if (c.phone) q = q.where((eb) => eb.or([eb('g.phone_primary', '=', c.phone!), eb('g.phone_secondary', '=', c.phone!), eb('g.whatsapp_number', '=', c.phone!)]));
    else if (c.digits) q = q.where('g.phone_primary', 'like', `%${escapeLike(c.digits.slice(-9))}`);
    else {
      const text = c.text.toLowerCase();
      const nameExpr = sql`lower(g.first_name || ' ' || g.last_name)`;
      q = q.where((eb) => eb.or([sql<boolean>`${nameExpr} % ${text}`, eb(nameExpr, 'like', `%${escapeLike(text)}%`)])).orderBy(sql`similarity(${nameExpr}, ${text})`, 'desc');
    }
    if (allowed) {
      q = q.where((eb) => eb.exists(eb.selectFrom('student_guardians as sg2').innerJoin('enrolments as e', (j) => j.onRef('e.student_id', '=', 'sg2.student_id').on('e.end_date', 'is', null))
        .select('sg2.student_id').whereRef('sg2.guardian_id', '=', 'g.id').where('e.class_id', 'in', allowed)));
    }
    return (await q.limit(limit).execute()).map((g) => ({ id: g.id, fullName: g.full_name, phone: g.phone_primary, childrenCount: g.children_count ?? 0 }));
  }

  private async staff(c: ReturnType<typeof classifyQuery>, limit: number) {
    if (c.codePrefix || c.receiptPrefix || c.classLike || c.digits) return [];
    const text = c.text.toLowerCase();
    const nameExpr = sql`lower(first_name || ' ' || last_name)`;
    const rows = await this.db.selectFrom('staff').select(['id', fullNameSql('staff').as('full_name'), 'job_title', 'staff_code']).where('archived_at', 'is', null)
      .where((eb) => eb.or([sql<boolean>`${nameExpr} % ${text}`, eb(nameExpr, 'like', `%${escapeLike(text)}%`), eb(sql`lower(staff_code)`, '=', text)]))
      .orderBy(sql`similarity(${nameExpr}, ${text})`, 'desc').limit(limit).execute();
    return rows.map((r) => ({ id: r.id, fullName: r.full_name, jobTitle: r.job_title, staffCode: r.staff_code }));
  }

  /** Read-only lookup on payments.receipt_no (owned by finance). */
  private async receipts(c: ReturnType<typeof classifyQuery>, limit: number) {
    let q = this.db.selectFrom('payments as p').innerJoin('students as s', 's.id', 'p.student_id')
      .select(['p.id', 'p.receipt_no', 'p.amount_pesewas', 'p.status', fullNameSql('s').as('student_name')]);
    if (c.receiptPrefix) {
      const m = /^(RCP|REV)-?(\d*)$/.exec(c.receiptPrefix)!;
      q = q.where('p.receipt_no', 'like', `${m[1]}-${m[2]}%`);
    } else q = q.where('p.receipt_no', 'like', `%${escapeLike(c.digits!)}`);
    return (await q.orderBy('p.receipt_no', 'desc').limit(limit).execute())
      .map((r) => ({ paymentId: r.id, receiptNo: r.receipt_no, studentName: r.student_name, amountPesewas: r.amount_pesewas, status: r.status }));
  }
}
