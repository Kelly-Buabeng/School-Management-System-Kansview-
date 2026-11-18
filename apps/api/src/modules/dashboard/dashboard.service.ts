// Owner: Agent B. Role-filtered dashboard widgets.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { todayInAccra } from '@sms/shared';
import { KYSELY, type Db } from '../../common/db/database.module';
import { LEDGER_SERVICE, type LedgerService } from '../../common/contracts';
import type { AuthUser } from '../../security/auth-user';
import { fullNameSql } from '../settings/common/db';
import { RecordAccess } from '../settings/common/record-access';
import { AcademicSetupService } from '../academic-setup/academic-setup.service';
import { upcomingBirthdays } from './birthdays';

const has = (u: AuthUser, ...roles: string[]) => u.roles.some((r) => roles.includes(r));

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger('DashboardService');
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(LEDGER_SERVICE) private readonly ledger: LedgerService,
    private readonly access: RecordAccess,
    private readonly setup: AcademicSetupService,
  ) {}

  async get(user: AuthUser) {
    const today = todayInAccra();
    const yearId = await this.setup.currentYearId();
    const term = await this.setup.currentTerm();
    const allowed = await this.access.allowedClassIds(user);
    const widgets: Record<string, unknown> = {};
    const all = has(user, 'ADMIN', 'HEADTEACHER');

    if (yearId && (all || has(user, 'REGISTRAR'))) widgets.enrolmentByClass = await this.enrolment(yearId, null);
    if (yearId && (all || has(user, 'REGISTRAR', 'TEACHER'))) widgets.upcomingBirthdays = await this.birthdays(yearId, has(user, 'ADMIN', 'HEADTEACHER', 'REGISTRAR') ? null : allowed, today);
    if (all || has(user, 'TEACHER')) widgets.attendanceTrend = await this.attendanceTrend(all ? null : allowed, today);
    if (term && user.permissions.has('finance_reports:read')) {
      try {
        const s = await this.ledger.termCollectionSummary(term.id);
        widgets.finance = { termId: term.id, termName: term.name, ...s, collectionRatePercent: s.billedPesewas ? Math.round((s.collectedPesewas * 1000) / s.billedPesewas) / 10 : null };
      } catch (err) {
        this.logger.error({ err: (err as Error).message, termId: term.id }, 'finance widget failed');
        widgets.finance = { error: 'Finance figures are not available right now' };
      }
    }
    return { generatedAt: new Date().toISOString(), today, currentAcademicYearId: yearId, currentTerm: term, widgets };
  }

  private async enrolment(yearId: string, allowed: string[] | null) {
    let q = this.db.selectFrom('classes as c').innerJoin('levels as l', 'l.id', 'c.level_id')
      .leftJoin('enrolments as e', (j) => j.onRef('e.class_id', '=', 'c.id').on('e.end_date', 'is', null))
      .leftJoin('students as s', 's.id', 'e.student_id')
      .select(['c.id', 'c.display_name', 'c.capacity', 'l.sort_order', sql<number>`count(e.id)::int`.as('enrolled'),
        sql<number>`count(e.id) filter (where s.gender = 'male')::int`.as('boys'), sql<number>`count(e.id) filter (where s.gender = 'female')::int`.as('girls')])
      .where('c.academic_year_id', '=', yearId).where('c.archived_at', 'is', null)
      .groupBy(['c.id', 'c.display_name', 'c.capacity', 'l.sort_order']).orderBy('l.sort_order').orderBy('c.display_name');
    if (allowed) q = q.where('c.id', 'in', allowed.length ? allowed : ['00000000-0000-0000-0000-000000000000']);
    const rows = await q.execute();
    return { totalStudents: rows.reduce((a, r) => a + r.enrolled, 0), classes: rows.map((r) => ({ classId: r.id, className: r.display_name, capacity: r.capacity, enrolled: r.enrolled, boys: r.boys, girls: r.girls })) };
  }

  private async birthdays(yearId: string, allowed: string[] | null, today: string) {
    if (allowed && allowed.length === 0) return [];
    let q = this.db.selectFrom('enrolments as e').innerJoin('students as s', 's.id', 'e.student_id').innerJoin('classes as c', 'c.id', 'e.class_id')
      .select(['s.id', fullNameSql('s').as('name'), 's.date_of_birth', 'c.display_name'])
      .where('e.end_date', 'is', null).where('e.academic_year_id', '=', yearId).where('s.status', '=', 'active').where('s.archived_at', 'is', null)
      // cheap pre-filter on day-of-year window (± wrap) before the exact calculation
      .where(sql<boolean>`(to_char(s.date_of_birth, 'MMDD') between to_char(${today}::date, 'MMDD') and to_char(${today}::date + 13, 'MMDD'))
                          or (to_char(${today}::date + 13, 'MMDD') < to_char(${today}::date, 'MMDD') and (to_char(s.date_of_birth, 'MMDD') >= to_char(${today}::date, 'MMDD') or to_char(s.date_of_birth, 'MMDD') <= to_char(${today}::date + 13, 'MMDD')))
                          or to_char(s.date_of_birth, 'MMDD') = '0229'`);
    if (allowed) q = q.where('e.class_id', 'in', allowed);
    const rows = await q.execute();
    return upcomingBirthdays(rows.map((r) => ({ id: r.id, name: r.name, dateOfBirth: r.date_of_birth, className: r.display_name })), today, 14)
      .map((r) => ({ studentId: r.id, name: r.name, className: r.className, birthday: r.birthday, turning: r.turning, inDays: r.inDays }));
  }

  private async attendanceTrend(allowed: string[] | null, today: string) {
    if (allowed && allowed.length === 0) return [];
    const from = addDays(today, -13);
    let q = this.db.selectFrom('attendance_sessions as s').innerJoin('attendance_records as r', 'r.session_id', 's.id')
      .select(['s.date', sql<number>`count(*)::int`.as('total'), sql<number>`count(*) filter (where r.status in ('present','late'))::int`.as('present')])
      .where('s.date', '>=', from).where('s.date', '<=', today).groupBy('s.date').orderBy('s.date');
    if (allowed) q = q.where('s.class_id', 'in', allowed);
    return (await q.execute()).map((r) => ({ date: r.date, total: r.total, present: r.present, ratePercent: r.total ? Math.round((r.present * 1000) / r.total) / 10 : null }));
  }
}
