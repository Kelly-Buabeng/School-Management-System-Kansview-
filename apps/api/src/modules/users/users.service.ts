import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db, type Tx } from '../../common/db/database.module';
import { pageOffset, type Page, type PageQuery } from '../../common/pagination';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { PasswordHasher } from '../../security/password-hasher';
import { ROLES } from '../../security/permissions';
import { SessionService } from '../../security/session.service';

const Username = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/, 'Use 3 to 64 letters, digits, dots, dashes or underscores');
const RoleList = z.array(z.enum(ROLES)).min(1).max(5).transform((r) => [...new Set(r)]);

export const CreateUserBody = z.strictObject({
  username: Username,
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).nullable().optional(),
  roles: RoleList,
  staffId: z.string().uuid().nullable().optional(),
});

export const UpdateUserBody = z.strictObject({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  roles: RoleList.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  staffId: z.string().uuid().nullable().optional(),
});

export const ListUsersQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'locked', 'disabled']).optional(),
});

export interface UserDto {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  roles: string[];
  status: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  staffId: string | null;
  version: number;
}

type UserRow = {
  id: string; username: string; full_name: string; email: string | null; roles: string[]; status: string; mfa_enabled: boolean;
  must_change_password: boolean; locked_until: Date | string | null; last_login_at: Date | string | null; staff_id: string | null; version: number;
};

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id, username: u.username, fullName: u.full_name, email: u.email, roles: u.roles, status: u.status, mfaEnabled: u.mfa_enabled,
    mustChangePassword: u.must_change_password, lockedUntil: iso(u.locked_until), lastLoginAt: iso(u.last_login_at), staffId: u.staff_id, version: u.version,
  };
}

const COLUMNS = ['id', 'username', 'full_name', 'email', 'roles', 'status', 'mfa_enabled', 'must_change_password', 'locked_until', 'last_login_at', 'staff_id', 'version'] as const;

/** Temporary passwords: 4 random words-ish chunks, easy to read out over the phone, ~80 bits. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async list(q: PageQuery & { q?: string; status?: string }): Promise<Page<UserDto>> {
    let base = this.db.selectFrom('users').where('archived_at', 'is', null);
    if (q.q) base = base.where((eb) => eb.or([eb('username', 'ilike', `%${q.q}%`), eb('full_name', 'ilike', `%${q.q}%`)]));
    if (q.status) base = base.where('status', '=', q.status as 'active');
    const { limit, offset } = pageOffset(q);
    const [rows, total] = await Promise.all([
      base.select(COLUMNS).orderBy('username').limit(limit).offset(offset).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    return { data: rows.map(toUserDto), page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) };
  }

  async get(id: string): Promise<UserDto> {
    return toUserDto(await this.load(id));
  }

  async create(body: z.infer<typeof CreateUserBody>, actor: AuthUser): Promise<{ user: UserDto; temporaryPassword: string }> {
    const temp = temporaryPassword();
    const hash = await this.hasher.hash(temp);
    return this.db.transaction().execute(async (tx) => {
      const exists = await tx.selectFrom('users').select('id').where('username', '=', body.username).executeTakeFirst();
      if (exists) throw new AppError(409, ErrorCodes.VALIDATION_FAILED, 'That username is already taken', undefined, [{ field: 'username', code: 'DUPLICATE', message: 'Already taken' }]);
      const row = await tx.insertInto('users').values({
        username: body.username, full_name: body.fullName, email: body.email ?? null, roles: body.roles, staff_id: body.staffId ?? null,
        password_hash: hash, must_change_password: true, created_by: actor.id, updated_by: actor.id,
      }).returning(COLUMNS).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'create', entityType: 'user', entityId: row.id, changes: { username: { after: row.username }, roles: { after: row.roles } } }, actor, tx);
      return { user: toUserDto(row), temporaryPassword: temp };
    });
  }

  async update(id: string, body: z.infer<typeof UpdateUserBody>, actor: AuthUser): Promise<UserDto> {
    return this.db.transaction().execute(async (tx) => {
      const before = await this.load(id, tx, true);
      if (id === actor.id && (body.roles !== undefined || body.status !== undefined)) {
        throw new AppError(422, ErrorCodes.FORBIDDEN, 'You cannot change your own roles or status', 'Ask another administrator.');
      }
      if (before.roles.includes('ADMIN') && ((body.roles && !body.roles.includes('ADMIN')) || body.status === 'disabled')) await this.assertAnotherAdmin(id, tx);
      const set: Record<string, unknown> = {};
      const changes: Record<string, { before?: unknown; after?: unknown }> = {};
      const track = (field: string, col: string, oldV: unknown, newV: unknown) => {
        if (newV === undefined || JSON.stringify(oldV) === JSON.stringify(newV)) return;
        set[col] = newV;
        changes[field] = { before: oldV, after: newV };
      };
      track('fullName', 'full_name', before.full_name, body.fullName);
      track('email', 'email', before.email, body.email);
      track('roles', 'roles', before.roles, body.roles);
      track('status', 'status', before.status, body.status);
      track('staffId', 'staff_id', before.staff_id, body.staffId);
      if (Object.keys(set).length === 0) return toUserDto(before);
      const row = await tx.updateTable('users').set({ ...set, updated_at: new Date(), updated_by: actor.id, version: sql`version + 1` })
        .where('id', '=', id).returning(COLUMNS).executeTakeFirstOrThrow();
      if (changes.roles || changes.status) await this.sessions.revokeAllForUser(id, 'roles or status changed', undefined, tx);
      await this.audit.record({ action: 'update', entityType: 'user', entityId: id, changes }, actor, tx);
      return toUserDto(row);
    });
  }

  async forceLogout(id: string, actor: AuthUser): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.load(id, tx);
      const n = await this.sessions.revokeAllForUser(id, `forced logout by ${actor.username}`, undefined, tx);
      await this.audit.record({ action: 'update', entityType: 'user', entityId: id, reason: `force logout (${n} sessions)` }, actor, tx);
    });
  }

  async unlock(id: string, actor: AuthUser): Promise<void> {
    if (id === actor.id) throw new AppError(422, ErrorCodes.FORBIDDEN, 'You cannot unlock your own account');
    await this.db.transaction().execute(async (tx) => {
      const u = await this.load(id, tx);
      await tx.updateTable('users').set({ failed_login_count: 0, locked_until: null, status: u.status === 'locked' ? 'active' : (u.status as 'active' | 'disabled'), updated_at: new Date(), updated_by: actor.id })
        .where('id', '=', id).execute();
      await this.audit.record({ action: 'update', entityType: 'user', entityId: id, reason: 'account unlocked', changes: { lockedUntil: { before: iso(u.locked_until), after: null } } }, actor, tx);
    });
  }

  async resetMfa(id: string, actor: AuthUser): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const u = await this.load(id, tx);
      await tx.updateTable('users').set({ mfa_enabled: false, mfa_secret_enc: null, mfa_recovery_codes_hash: null, updated_at: new Date(), updated_by: actor.id })
        .where('id', '=', id).execute();
      await this.sessions.revokeAllForUser(id, 'MFA reset by administrator', undefined, tx);
      await this.audit.record({ action: 'update', entityType: 'user', entityId: id, reason: 'MFA reset', changes: { mfaEnabled: { before: u.mfa_enabled, after: false } } }, actor, tx);
    });
  }

  async adminResetPassword(id: string, actor: AuthUser): Promise<{ temporaryPassword: string }> {
    const temp = temporaryPassword();
    const hash = await this.hasher.hash(temp);
    await this.db.transaction().execute(async (tx) => {
      await this.load(id, tx);
      await tx.updateTable('users').set({ password_hash: hash, must_change_password: true, password_changed_at: new Date(), failed_login_count: 0, locked_until: null, updated_at: new Date(), updated_by: actor.id })
        .where('id', '=', id).execute();
      await this.sessions.revokeAllForUser(id, 'password reset by administrator', undefined, tx);
      await this.audit.record({ action: 'update', entityType: 'user', entityId: id, reason: 'administrator reset password', changes: { password: { after: 'reset' } } }, actor, tx);
    });
    return { temporaryPassword: temp };
  }

  private async load(id: string, db: Db | Tx = this.db, lock = false): Promise<UserRow> {
    let q = db.selectFrom('users').select(COLUMNS).where('id', '=', id).where('archived_at', 'is', null);
    if (lock) q = q.forUpdate();
    const u = await q.executeTakeFirst();
    if (!u) throw AppError.notFound('user');
    return u;
  }

  private async assertAnotherAdmin(exceptId: string, tx: Tx): Promise<void> {
    const r = await tx.selectFrom('users').select((eb) => eb.fn.countAll<string>().as('n'))
      .where('id', '<>', exceptId).where('status', '=', 'active').where('archived_at', 'is', null)
      .where(sql<boolean>`'ADMIN' = ANY(roles)`).executeTakeFirst();
    if (Number(r?.n ?? 0) === 0) throw new AppError(422, ErrorCodes.FORBIDDEN, 'The school must keep at least one active administrator');
  }
}
