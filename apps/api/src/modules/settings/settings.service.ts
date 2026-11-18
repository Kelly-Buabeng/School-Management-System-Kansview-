// Owner: Agent B. School profile and policy switches.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { UPLOAD_PIPELINE, UPLOAD_POLICIES, type UploadPipeline } from '../../security/upload-pipeline';
import { isoInstant } from './common/db';
import { versionConflict, zOptText } from './common/http';
import { mergePolicies, POLICY_KEYS, policiesEtag, type Policies, type PolicyKey, type UpdatePoliciesBody } from './policies';

export const UpdateSchoolProfileBody = z.strictObject({
  name: z.string().trim().min(2).max(150).optional(),
  schoolCode: z.string().regex(/^[A-Z]{3}$/, 'Three capital letters, e.g. KSV').optional(),
  motto: zOptText(200).nullable(),
  address: zOptText(300).nullable(),
  phone: zOptText(40).nullable(),
  email: z.string().email().max(150).nullable().optional(),
});
export type UpdateSchoolProfileBody = z.infer<typeof UpdateSchoolProfileBody>;

export interface SchoolProfileDto {
  name: string;
  schoolCode: string;
  schoolCodeLocked: boolean;
  motto: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoFileId: string | null;
  timezone: string;
  currency: string;
  version: number;
  updatedAt: string | null;
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UPLOAD_PIPELINE) private readonly uploads: UploadPipeline,
  ) {}

  // ---------------- policies ----------------
  async getPolicies(tx?: Tx): Promise<{ policies: Policies; etag: string }> {
    const rows = await (tx ?? this.db).selectFrom('settings').select(['key', 'value']).where('key', 'in', POLICY_KEYS).execute();
    const { policies } = mergePolicies(rows);
    return { policies, etag: policiesEtag(policies) };
  }

  async getPolicy<K extends PolicyKey>(key: K, tx?: Tx): Promise<Policies[K]> {
    return (await this.getPolicies(tx)).policies[key];
  }

  async updatePolicies(body: UpdatePoliciesBody, ifMatch: string, user: AuthUser): Promise<{ policies: Policies; etag: string }> {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('app.settings.policies'))`.execute(tx);
      const current = await this.getPolicies(tx);
      if (current.etag !== ifMatch) throw versionConflict();
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const key of POLICY_KEYS) {
        const value = body[key];
        if (value === undefined || value === current.policies[key]) continue;
        changes[key] = { before: current.policies[key], after: value };
        await tx
          .insertInto('settings')
          .values({ key, value: JSON.stringify(value), created_by: user.id, updated_by: user.id })
          .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: user.id, updated_at: sql`now()`, version: sql`settings.version + 1` }))
          .execute();
      }
      if (Object.keys(changes).length > 0) {
        await this.audit.record({ action: 'update', entityType: 'settings', entityId: 'policies', changes }, user, tx);
      }
      return this.getPolicies(tx);
    });
  }

  // ---------------- school profile ----------------
  async getSchoolProfile(tx?: Tx): Promise<SchoolProfileDto> {
    const db = tx ?? this.db;
    const row = await db.selectFrom('school_profile').selectAll().where('id', '=', 1).executeTakeFirst();
    const locked = await this.schoolCodeLocked(tx);
    if (!row) {
      return { name: '', schoolCode: 'KSV', schoolCodeLocked: locked, motto: null, address: null, phone: null, email: null, logoFileId: null, timezone: 'Africa/Accra', currency: 'GHS', version: 0, updatedAt: null };
    }
    return {
      name: row.name, schoolCode: row.school_code, schoolCodeLocked: locked, motto: row.motto, address: row.address, phone: row.phone,
      email: row.email, logoFileId: row.logo_file_id, timezone: row.timezone, currency: row.currency, version: row.version, updatedAt: isoInstant(row.updated_at),
    };
  }

  private async schoolCodeLocked(tx?: Tx): Promise<boolean> {
    const r = await (tx ?? this.db).selectFrom('students').select('id').limit(1).executeTakeFirst();
    return !!r;
  }

  async updateSchoolProfile(body: UpdateSchoolProfileBody, version: number, user: AuthUser): Promise<SchoolProfileDto> {
    return this.db.transaction().execute(async (tx) => {
      const before = await this.getSchoolProfile(tx);
      if (before.version !== version) throw versionConflict();
      if (body.schoolCode && body.schoolCode !== before.schoolCode && before.schoolCodeLocked) {
        throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'The school code cannot be changed after the first student is admitted', 'Student codes already printed on records use the current school code.');
      }
      const patch = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.schoolCode !== undefined && { school_code: body.schoolCode }),
        ...(body.motto !== undefined && { motto: body.motto }),
        ...(body.address !== undefined && { address: body.address }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.email !== undefined && { email: body.email }),
      };
      if (before.version === 0) {
        if (!body.name) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Enter the school name');
        await tx.insertInto('school_profile').values({ id: 1, name: body.name, school_code: body.schoolCode ?? 'KSV', ...patch, created_by: user.id, updated_by: user.id }).execute();
      } else {
        await tx.updateTable('school_profile').set({ ...patch, updated_by: user.id, version: sql`version + 1` }).where('id', '=', 1).execute();
      }
      const after = await this.getSchoolProfile(tx);
      await this.audit.record({ action: 'update', entityType: 'school_profile', entityId: '1', changes: diff(before, after, Object.keys(body)) }, user, tx);
      return after;
    });
  }

  async uploadLogo(file: { originalname: string; buffer: Buffer; mimetype?: string } | undefined, user: AuthUser): Promise<SchoolProfileDto> {
    if (!file) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Choose a logo file to upload');
    const accepted = await this.uploads.accept({ originalName: file.originalname, buffer: file.buffer, declaredMimeType: file.mimetype }, UPLOAD_POLICIES.logo, user.id);
    return this.db.transaction().execute(async (tx) => {
      const exists = await tx.selectFrom('school_profile').select('id').where('id', '=', 1).executeTakeFirst();
      if (!exists) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Save the school name before uploading a logo');
      await tx.updateTable('school_profile').set({ logo_file_id: accepted.fileId, updated_by: user.id, version: sql`version + 1` }).where('id', '=', 1).execute();
      await this.audit.record({ action: 'update', entityType: 'school_profile', entityId: '1', changes: { logoFileId: { after: accepted.fileId } } }, user, tx);
      return this.getSchoolProfile(tx);
    });
  }
}

function diff(before: object, after: object, keys: string[]): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const k of keys) if (b[k] !== a[k]) out[k] = { before: b[k], after: a[k] };
  return out;
}
