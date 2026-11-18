// Owner: Agent B. Incidents (restricted: ADMIN, HEADTEACHER, and the author) and health visits (medical, restricted).
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { fullNameSql, isoInstant } from '../settings/common/db';
import { parseId } from '../settings/common/http';
import { RecordAccess } from '../settings/common/record-access';

const instant = z.string().datetime({ offset: true });
export const IncidentBody = z.strictObject({
  occurredAt: instant,
  category: z.string().trim().min(2).max(60),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  description: z.string().trim().min(3).max(2000),
  actionTaken: z.string().trim().max(1000).optional(),
  guardianInformedAt: instant.optional(),
  followUp: z.string().trim().max(1000).optional(),
});
export const UpdateIncidentBody = z.strictObject({
  category: z.string().trim().min(2).max(60).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  description: z.string().trim().min(3).max(2000).optional(),
  actionTaken: z.string().trim().max(1000).nullable().optional(),
  guardianInformedAt: instant.nullable().optional(),
  followUp: z.string().trim().max(1000).nullable().optional(),
});
export const ListIncidentsQuery = z.strictObject({ from: z.string().optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).optional() });
export const HealthVisitBody = z.strictObject({
  visitedAt: instant.optional(),
  complaint: z.string().trim().min(2).max(500),
  treatmentGiven: z.string().trim().max(500).optional(),
  medicationGiven: z.string().trim().max(300).optional(),
  sentHome: z.boolean().default(false),
  guardianInformedAt: instant.optional(),
});
export const UpdateHealthVisitBody = z.strictObject({
  complaint: z.string().trim().min(2).max(500).optional(),
  treatmentGiven: z.string().trim().max(500).nullable().optional(),
  medicationGiven: z.string().trim().max(300).nullable().optional(),
  sentHome: z.boolean().optional(),
  guardianInformedAt: instant.nullable().optional(),
});

const INC: Record<string, string> = { occurredAt: 'occurred_at', category: 'category', severity: 'severity', description: 'description', actionTaken: 'action_taken', guardianInformedAt: 'guardian_informed_at', followUp: 'follow_up' };
const HV: Record<string, string> = { visitedAt: 'visited_at', complaint: 'complaint', treatmentGiven: 'treatment_given', medicationGiven: 'medication_given', sentHome: 'sent_home', guardianInformedAt: 'guardian_informed_at' };
const map = (m: Record<string, string>, body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [m[k]!, v]));

/** Who sees every incident (others only their own entries). */
const seesAllIncidents = (u: AuthUser) => u.roles.includes('ADMIN') || u.roles.includes('HEADTEACHER');

@Injectable()
export class WelfareService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    private readonly access: RecordAccess,
  ) {}

  private incidents() {
    return this.db.selectFrom('incidents as i').innerJoin('students as s', 's.id', 'i.student_id').leftJoin('users as u', 'u.id', 'i.reported_by')
      .selectAll('i').select(['s.student_code', fullNameSql('s').as('student_name'), 'u.full_name as reported_by_name']).where('i.archived_at', 'is', null);
  }

  private incidentDto(r: Awaited<ReturnType<ReturnType<WelfareService['incidents']>['executeTakeFirstOrThrow']>>) {
    return {
      id: r.id, studentId: r.student_id, studentCode: r.student_code, studentName: r.student_name, occurredAt: isoInstant(r.occurred_at), category: r.category, severity: r.severity,
      description: r.description, actionTaken: r.action_taken, reportedBy: r.reported_by_name, reportedByUserId: r.reported_by, guardianInformedAt: isoInstant(r.guardian_informed_at),
      followUp: r.follow_up, version: r.version, createdAt: isoInstant(r.created_at),
    };
  }

  async listForStudent(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    let q = this.incidents().where('i.student_id', '=', s.id);
    if (!seesAllIncidents(user)) q = q.where('i.reported_by', '=', user.id);
    const rows = await q.orderBy('i.occurred_at', 'desc').execute();
    await this.audit.record({ action: 'view', entityType: 'incidents', entityId: s.id, studentId: s.id }, user);
    return rows.map((r) => this.incidentDto(r));
  }

  async list(user: AuthUser, q: z.infer<typeof ListIncidentsQuery>) {
    let query = this.incidents();
    if (!seesAllIncidents(user)) query = query.where('i.reported_by', '=', user.id);
    if (q.severity) query = query.where('i.severity', '=', q.severity);
    if (q.from) query = query.where('i.occurred_at', '>=', new Date(q.from));
    return (await query.orderBy('i.occurred_at', 'desc').limit(500).execute()).map((r) => this.incidentDto(r));
  }

  async createIncident(rawId: string, body: z.infer<typeof IncidentBody>, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const id = await this.db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('incidents').values({ student_id: s.id, ...map(INC, body), reported_by: user.id, created_by: user.id, updated_by: user.id } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'incident', entityId: r.id, studentId: s.id, changes: { category: { after: body.category }, severity: { after: body.severity } } }, user, tx);
      return r.id;
    });
    return this.incidentDto(await this.incidents().where('i.id', '=', id).executeTakeFirstOrThrow());
  }

  async updateIncident(rawId: string, body: z.infer<typeof UpdateIncidentBody>, user: AuthUser) {
    const id = parseId(rawId, 'incident');
    const cur = await this.incidents().where('i.id', '=', id).executeTakeFirst();
    if (!cur || (!seesAllIncidents(user) && cur.reported_by !== user.id)) throw AppError.notFound('incident');
    await this.access.student(user, cur.student_id, { includeArchived: true });
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('incidents').set({ ...map(INC, body), updated_by: user.id } as never).where('id', '=', id).execute();
      await this.audit.record({ action: 'update', entityType: 'incident', entityId: id, studentId: cur.student_id, changes: Object.fromEntries(Object.keys(body).map((k) => [k, { after: '[changed]' }])) }, user, tx);
    });
    return this.incidentDto(await this.incidents().where('i.id', '=', id).executeTakeFirstOrThrow());
  }

  // ---------------- health visits ----------------
  private visits() {
    return this.db.selectFrom('health_visits as h').leftJoin('users as u', 'u.id', 'h.attended_by').selectAll('h').select('u.full_name as attended_by_name').where('h.archived_at', 'is', null);
  }
  private visitDto(r: Awaited<ReturnType<ReturnType<WelfareService['visits']>['executeTakeFirstOrThrow']>>) {
    return {
      id: r.id, studentId: r.student_id, visitedAt: isoInstant(r.visited_at), complaint: r.complaint, treatmentGiven: r.treatment_given, medicationGiven: r.medication_given,
      sentHome: r.sent_home, guardianInformedAt: isoInstant(r.guardian_informed_at), attendedBy: r.attended_by_name, version: r.version,
    };
  }

  async listVisits(rawId: string, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const rows = await this.visits().where('h.student_id', '=', s.id).orderBy('h.visited_at', 'desc').execute();
    await this.audit.record({ action: 'view', entityType: 'health_visits', entityId: s.id, studentId: s.id }, user);
    return rows.map((r) => this.visitDto(r));
  }

  async createVisit(rawId: string, body: z.infer<typeof HealthVisitBody>, user: AuthUser) {
    const s = await this.access.student(user, rawId);
    const id = await this.db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('health_visits').values({ student_id: s.id, ...map(HV, body), attended_by: user.id, created_by: user.id, updated_by: user.id } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'health_visit', entityId: r.id, studentId: s.id, changes: { sentHome: { after: body.sentHome } } }, user, tx);
      return r.id;
    });
    const out = this.visitDto(await this.visits().where('h.id', '=', id).executeTakeFirstOrThrow());
    return user.permissions.has('health_visits:read') ? out : { id: out.id, studentId: out.studentId, visitedAt: out.visitedAt };
  }

  async updateVisit(rawId: string, body: z.infer<typeof UpdateHealthVisitBody>, user: AuthUser) {
    const id = parseId(rawId, 'health visit');
    const cur = await this.visits().where('h.id', '=', id).executeTakeFirst();
    if (!cur) throw AppError.notFound('health visit');
    await this.access.student(user, cur.student_id, { includeArchived: true });
    if (Object.keys(body).length === 0) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Nothing to change');
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('health_visits').set({ ...map(HV, body), updated_by: user.id } as never).where('id', '=', id).execute();
      await this.audit.record({ action: 'update', entityType: 'health_visit', entityId: id, studentId: cur.student_id, changes: Object.fromEntries(Object.keys(body).map((k) => [k, { after: '[changed]' }])) }, user, tx);
    });
    return this.visitDto(await this.visits().where('h.id', '=', id).executeTakeFirstOrThrow());
  }
}
