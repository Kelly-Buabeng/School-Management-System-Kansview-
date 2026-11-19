import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import { KYSELY, type Db } from '../../common/db/database.module';
import { NOTIFICATION_SERVICE, type NotificationService } from '../../common/contracts/notifications';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_CRYPTO } from '../../security/field-crypto';
import type { FieldCryptoEngine } from '../../security/field-crypto.service';
import { PasswordHasher } from '../../security/password-hasher';
import { assertStrongPassword } from '../../security/password-policy';
import { permissionsForRoles, ROLES, type Role } from '../../security/permissions';
import { RATE_LIMITS, RateLimiter } from '../../security/rate-limiter';
import { MFA_REQUIRED_ROLES, SessionService, sessionPhase, type NewSession } from '../../security/session.service';
import { sessionStateOf } from '../../security/session-resolver.impl';
import {
  consumeRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, looksLikeRecoveryCode,
  totpKeyUri, TotpReplayGuard, verifyTotp,
} from '../../security/totp';
import type { LoginResponseDto, MeDto } from './auth.dto';

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_BASE_MS = 15 * 60_000;
export const LOCKOUT_MAX_MS = 24 * 60 * 60_000;
export const RESET_TOKEN_TTL_MS = 30 * 60_000;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  existingSessionRaw: string | null;
}

const INVALID = () => new AppError(401, ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Wrong username or password');
const LOCKED = (until?: Date) =>
  new AppError(423, ErrorCodes.AUTH_ACCOUNT_LOCKED, 'This account is locked for a while after too many wrong attempts',
    'Wait and try again later, or ask the administrator to unlock it.', undefined, until ? { lockedUntil: until.toISOString() } : undefined);

/** Lock duration after the n-th lockout: 15 min, 30 min, 1 h, 2 h ... capped at 24 h. */
export function lockDurationMs(failedCount: number): number {
  const lockouts = Math.floor(failedCount / LOCKOUT_THRESHOLD);
  return Math.min(LOCKOUT_BASE_MS * 2 ** Math.max(0, lockouts - 1), LOCKOUT_MAX_MS);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly replay = new TotpReplayGuard();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCryptoEngine,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ---------------- login ----------------

  async login(usernameIn: string, password: string, client: ClientInfo, res?: { setHeader(n: string, v: string): unknown }): Promise<{ body: LoginResponseDto; session: NewSession }> {
    const username = usernameIn.trim().toLowerCase();
    this.limiter.enforce(`login:ip:${client.ip}`, RATE_LIMITS.loginPerIp, res);
    this.limiter.enforce(`login:ipuser:${client.ip}:${username}`, RATE_LIMITS.loginPerIpUser, res);

    const user = await this.db.selectFrom('users').selectAll().where('username', '=', username).where('archived_at', 'is', null).executeTakeFirst();

    if (!user) {
      await this.hasher.dummyVerify(password);
      const recentFailures = await this.recentFailures(username);
      await this.recordAttempt(username, client.ip, false, 'unknown user');
      await this.audit.record({ action: 'login_failed', entityType: 'user', reason: 'unknown username' }, null);
      // Same lockout behaviour as a real account, so lockout cannot reveal which usernames exist.
      if (recentFailures + 1 > LOCKOUT_THRESHOLD) throw LOCKED();
      throw INVALID();
    }

    const actor = this.actorOf(user);
    const now = new Date();
    const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
    const ok = await this.hasher.verify(user.password_hash, password);

    if (user.status === 'locked' || (lockedUntil && lockedUntil > now)) {
      await this.recordAttempt(username, client.ip, false, 'locked');
      await this.audit.record({ action: 'login_failed', entityType: 'user', entityId: user.id, reason: 'account locked' }, actor);
      throw LOCKED(lockedUntil ?? undefined);
    }
    if (!ok) {
      if (await this.registerFailure(user.id, username, client.ip, 'wrong password', actor)) throw LOCKED();
      throw INVALID();
    }
    if (user.status === 'disabled') {
      await this.recordAttempt(username, client.ip, false, 'disabled');
      await this.audit.record({ action: 'login_failed', entityType: 'user', entityId: user.id, reason: 'account disabled' }, actor);
      throw new AppError(403, ErrorCodes.AUTH_ACCOUNT_DISABLED, 'This account is turned off', 'Ask the administrator if you still need access.');
    }

    const upgrade = this.hasher.needsRehash(user.password_hash) ? await this.hasher.hash(password) : null;
    const phase = sessionPhase(user, { mfa_verified_at: null });
    // CP5-01: for an account with MFA the password alone is only half of the login. The failure counter is
    // shared with wrong MFA codes and is reset only after the MFA step succeeds (verifyMfa); resetting it here
    // would let anyone who knows the password try 4 codes, log in again, try 4 more, and never be locked.
    const resetFailures = phase !== 'mfa_pending';
    await this.db.updateTable('users').set({
      ...(resetFailures ? { failed_login_count: 0, locked_until: null } : {}),
      last_login_at: now, updated_at: now,
      ...(upgrade ? { password_hash: upgrade } : {}),
    }).where('id', '=', user.id).execute();
    await this.recordAttempt(username, client.ip, true, null);
    this.limiter.reset(`login:ipuser:${client.ip}:${username}`);

    // Session fixation: any session presented with the login request is revoked and a new id issued.
    if (client.existingSessionRaw) await this.sessions.revoke(createHash('sha256').update(client.existingSessionRaw).digest('hex'), 'replaced by new login');
    const session = await this.sessions.create(user.id, { ip: client.ip, userAgent: client.userAgent, mfaVerified: false });
    await this.audit.record({ action: 'login', entityType: 'user', entityId: user.id, reason: phase === 'full' ? null : `step: ${phase}` }, { ...actor, sessionId: session.hash });

    return {
      session,
      body: {
        mfaRequired: phase === 'mfa_pending',
        mfaEnrolmentRequired: phase === 'mfa_enrolment',
        mustChangePassword: user.must_change_password,
        user: this.me(user, session.hash, phase),
      },
    };
  }

  // ---------------- MFA ----------------

  async verifyMfa(authUser: AuthUser, code: string, client: ClientInfo, res?: { setHeader(n: string, v: string): unknown }): Promise<{ body: MeDto; session: NewSession }> {
    const state = sessionStateOf(authUser);
    if (!state || state.phase !== 'mfa_pending') throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'No sign-in code is needed now');
    this.limiter.enforce(`mfa:${state.sessionHash}`, RATE_LIMITS.mfaPerSession, res);
    const user = await this.loadUser(authUser.id);
    const actor = this.actorOf(user);
    // CP5-01: a lock (or a disabled account) also stops sessions that were waiting for their MFA code.
    const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
    if (user.status !== 'active' || user.archived_at || (lockedUntil && lockedUntil > new Date())) {
      await this.sessions.revoke(state.sessionHash, 'account locked or disabled during MFA');
      await this.recordAttempt(user.username, client.ip, false, 'locked');
      await this.audit.record({ action: 'login_failed', entityType: 'user', entityId: user.id, reason: 'account locked or disabled during MFA' }, actor);
      throw LOCKED(lockedUntil ?? undefined);
    }
    if (!user.mfa_secret_enc) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Two-step sign-in is not set up');

    let ok = false;
    let usedRecovery = false;
    if (looksLikeRecoveryCode(code)) {
      const remaining = consumeRecoveryCode(code, user.mfa_recovery_codes_hash ?? []);
      if (remaining) {
        await this.db.updateTable('users').set({ mfa_recovery_codes_hash: remaining }).where('id', '=', user.id).execute();
        ok = true;
        usedRecovery = true;
      }
    } else {
      const step = verifyTotp(code, this.crypto.decrypt(user.mfa_secret_enc), this.replay.get(user.id));
      if (step !== null) {
        this.replay.set(user.id, step);
        ok = true;
      }
    }
    if (!ok) {
      const locked = await this.registerFailure(user.id, user.username, client.ip, looksLikeRecoveryCode(code) ? 'wrong MFA recovery code' : 'wrong MFA code', actor);
      if (locked) {
        // Every session still waiting for a code is ended, not only this one.
        await this.revokeMfaPendingSessions(user.id, 'locked during MFA');
        throw LOCKED(locked);
      }
      throw new AppError(401, ErrorCodes.AUTH_MFA_INVALID, 'That code is not right. Check the time on your phone and try again.');
    }
    await this.db.updateTable('users').set({ failed_login_count: 0, locked_until: null }).where('id', '=', user.id).execute();
    const session = await this.sessions.rotate(state.sessionHash, user.id, { ip: client.ip, userAgent: client.userAgent, mfaVerified: true }, 'rotated after MFA');
    await this.audit.record({ action: 'login', entityType: 'user', entityId: user.id, reason: usedRecovery ? 'MFA with recovery code' : 'MFA verified' }, { ...actor, sessionId: session.hash });
    return { session, body: this.me(user, session.hash, sessionPhase(user, { mfa_verified_at: new Date() })) };
  }

  async startMfaSetup(authUser: AuthUser): Promise<{ otpauthUri: string; secret: string }> {
    const user = await this.loadUser(authUser.id);
    if (user.mfa_enabled) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Two-step sign-in is already set up', 'Ask the administrator to reset it if you changed phone.');
    const secret = generateTotpSecret();
    await this.db.updateTable('users').set({ mfa_secret_enc: this.crypto.encrypt(secret), updated_at: new Date() }).where('id', '=', user.id).execute();
    return { otpauthUri: totpKeyUri(user.username, secret), secret };
  }

  async enableMfa(authUser: AuthUser, code: string, client: ClientInfo): Promise<{ body: { recoveryCodes: string[]; user: MeDto }; session: NewSession | null }> {
    const user = await this.loadUser(authUser.id);
    if (user.mfa_enabled) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Two-step sign-in is already set up');
    if (!user.mfa_secret_enc) throw new AppError(422, ErrorCodes.VALIDATION_FAILED, 'Start the set-up first');
    const step = verifyTotp(code, this.crypto.decrypt(user.mfa_secret_enc), this.replay.get(user.id));
    if (step === null) throw new AppError(401, ErrorCodes.AUTH_MFA_INVALID, 'That code is not right. Check the time on your phone and try again.');
    this.replay.set(user.id, step);
    const recoveryCodes = generateRecoveryCodes();
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ mfa_enabled: true, mfa_recovery_codes_hash: recoveryCodes.map(hashRecoveryCode), updated_at: new Date(), updated_by: user.id, version: sql`version + 1` })
        .where('id', '=', user.id).execute();
      await this.audit.record({ action: 'update', entityType: 'user', entityId: user.id, changes: { mfaEnabled: { before: false, after: true } } }, authUser, tx);
    });
    const state = sessionStateOf(authUser);
    let session: NewSession | null = null;
    let hash = authUser.sessionId;
    if (state) {
      session = await this.sessions.rotate(state.sessionHash, user.id, { ip: client.ip, userAgent: client.userAgent, mfaVerified: true }, 'rotated after MFA enrolment');
      hash = session.hash;
    }
    const updated = { ...user, mfa_enabled: true };
    return { session, body: { recoveryCodes, user: this.me(updated, hash, sessionPhase(updated, { mfa_verified_at: new Date() })) } };
  }

  async disableMfa(authUser: AuthUser, password: string): Promise<void> {
    const user = await this.loadUser(authUser.id);
    if (user.roles.some((r) => (MFA_REQUIRED_ROLES as string[]).includes(r))) {
      throw new AppError(422, ErrorCodes.AUTH_MFA_REQUIRED, 'Two-step sign-in cannot be turned off for your role');
    }
    if (!(await this.hasher.verify(user.password_hash, password))) throw INVALID();
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ mfa_enabled: false, mfa_secret_enc: null, mfa_recovery_codes_hash: null, updated_at: new Date(), updated_by: user.id })
        .where('id', '=', user.id).execute();
      await this.audit.record({ action: 'update', entityType: 'user', entityId: user.id, changes: { mfaEnabled: { before: user.mfa_enabled, after: false } } }, authUser, tx);
    });
  }

  // ---------------- logout / me ----------------

  async logout(authUser: AuthUser): Promise<void> {
    await this.sessions.revoke(authUser.sessionId, 'logout');
    await this.audit.record({ action: 'logout', entityType: 'user', entityId: authUser.id }, authUser);
  }

  async getMe(authUser: AuthUser): Promise<MeDto> {
    const user = await this.loadUser(authUser.id);
    const state = sessionStateOf(authUser);
    return this.me(user, authUser.sessionId, state?.phase ?? 'full', state?.csrfToken);
  }

  // ---------------- passwords ----------------

  async changePassword(authUser: AuthUser, current: string, next: string): Promise<void> {
    const user = await this.loadUser(authUser.id);
    if (!(await this.hasher.verify(user.password_hash, current))) {
      throw new AppError(400, ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Your current password is not right', undefined, [{ field: 'currentPassword', code: 'INVALID', message: 'Not right' }]);
    }
    if (current === next) throw new AppError(400, ErrorCodes.AUTH_PASSWORD_TOO_WEAK, 'Choose a password different from the current one');
    assertStrongPassword(next, { username: user.username, fullName: user.full_name, email: user.email });
    const hash = await this.hasher.hash(next);
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ password_hash: hash, password_changed_at: new Date(), must_change_password: false, updated_at: new Date(), updated_by: user.id })
        .where('id', '=', user.id).execute();
      await this.sessions.revokeAllForUser(user.id, 'password changed', authUser.sessionId, tx);
      await this.audit.record({ action: 'update', entityType: 'user', entityId: user.id, changes: { password: { after: 'changed' } } }, authUser, tx);
    });
  }

  /** Always behaves the same whether or not the account exists (no enumeration). */
  async requestPasswordReset(identifier: string, ip: string | null, res?: { setHeader(n: string, v: string): unknown }): Promise<void> {
    this.limiter.enforce(`reset:ip:${ip}`, RATE_LIMITS.resetPerIp, res);
    const id = identifier.trim().toLowerCase();
    const allowed = this.limiter.consume(`reset:acct:${id}`, RATE_LIMITS.resetPerAccount).allowed;
    const user = await this.db.selectFrom('users').select(['id', 'username', 'staff_id', 'status'])
      .where((eb) => eb.or([eb('username', '=', id), eb(sql`lower(email)`, '=', id)]))
      .where('archived_at', 'is', null).executeTakeFirst();
    if (!user || user.status === 'disabled' || !allowed) {
      if (user && !allowed) this.logger.warn({ userId: user.id }, 'password reset rate limited for account');
      return;
    }
    const token = await this.issueResetToken(user.id, null);
    await this.deliverResetToken(user, token);
    await this.audit.record({ action: 'create', entityType: 'password_reset_token', entityId: user.id, reason: 'self-service reset requested' }, null);
  }

  async issueResetToken(userId: string, createdBy: string | null, db: Db = this.db): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await db.insertInto('password_reset_tokens').values({
      user_id: userId, token_hash: createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS), created_by: createdBy,
    }).execute();
    return token;
  }

  async resetPassword(token: string, next: string): Promise<void> {
    const hash = createHash('sha256').update(token).digest('hex');
    const bad = () => new AppError(400, ErrorCodes.AUTH_RESET_TOKEN_INVALID, 'This reset link is not valid any more', 'Ask for a new one. Links work once and expire after 30 minutes.');
    await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('password_reset_tokens').select(['id', 'user_id', 'expires_at', 'used_at']).where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) throw bad();
      const user = await tx.selectFrom('users').selectAll().where('id', '=', row.user_id).executeTakeFirstOrThrow();
      if (user.status === 'disabled' || user.archived_at) throw bad();
      assertStrongPassword(next, { username: user.username, fullName: user.full_name, email: user.email });
      await tx.updateTable('password_reset_tokens').set({ used_at: new Date() }).where('id', '=', row.id).execute();
      await tx.updateTable('password_reset_tokens').set({ used_at: new Date() }).where('user_id', '=', user.id).where('used_at', 'is', null).execute();
      await tx.updateTable('users').set({
        password_hash: await this.hasher.hash(next), password_changed_at: new Date(), must_change_password: false,
        failed_login_count: 0, locked_until: null, updated_at: new Date(),
      }).where('id', '=', user.id).execute();
      await this.sessions.revokeAllForUser(user.id, 'password reset', undefined, tx);
      await this.audit.record({ action: 'update', entityType: 'user', entityId: user.id, changes: { password: { after: 'reset' } }, reason: 'password reset with token' }, null, tx);
    });
  }

  // ---------------- helpers ----------------

  me(user: { id: string; username: string; full_name: string; roles: string[]; mfa_enabled: boolean; must_change_password: boolean }, sessionHash: string, phase: string, csrf?: string): MeDto {
    const roles = this.rolesOf(user.roles);
    return {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      roles,
      permissions: phase === 'full' ? [...permissionsForRoles(roles)].sort() : [],
      csrfToken: csrf ?? this.sessions.csrfToken(sessionHash),
      mfaEnabled: user.mfa_enabled,
      mustChangePassword: user.must_change_password,
      sessionPhase: phase,
    };
  }

  private rolesOf(roles: string[]): Role[] {
    return roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  }

  private actorOf(user: { id: string; username: string; full_name: string; roles: string[]; staff_id: string | null }): AuthUser {
    const roles = this.rolesOf(user.roles);
    return { id: user.id, username: user.username, fullName: user.full_name, roles, permissions: new Set(), sessionId: '', staffId: user.staff_id, mfaVerified: false };
  }

  private async loadUser(id: string) {
    const u = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!u) throw new AppError(401, ErrorCodes.UNAUTHENTICATED, 'Please sign in');
    return u;
  }

  /**
   * Counts one failed password or MFA attempt and locks the account at every LOCKOUT_THRESHOLD-th failure.
   * The increment is done in the database (not from the value read earlier) so parallel guesses, for example
   * from several MFA-pending sessions, cannot overwrite each other's count and skip the lock.
   * Returns the lock expiry when this failure locked the account.
   */
  private async registerFailure(userId: string, username: string, ip: string | null, reason: string, actor: AuthUser): Promise<Date | undefined> {
    const row = await this.db.updateTable('users').set({ failed_login_count: sql<number>`failed_login_count + 1` })
      .where('id', '=', userId).returning('failed_login_count').executeTakeFirstOrThrow();
    const count = row.failed_login_count;
    const lock = count % LOCKOUT_THRESHOLD === 0 ? new Date(Date.now() + lockDurationMs(count)) : undefined;
    if (lock) await this.db.updateTable('users').set({ locked_until: lock }).where('id', '=', userId).execute();
    await this.recordAttempt(username, ip, false, reason);
    await this.audit.record({ action: 'login_failed', entityType: 'user', entityId: userId, reason: lock ? `${reason}; account locked until ${lock.toISOString()}` : reason }, actor);
    return lock;
  }

  /** Ends every live session of the user that has not finished the MFA step. */
  private async revokeMfaPendingSessions(userId: string, reason: string): Promise<void> {
    await this.db.updateTable('user_sessions').set({ revoked_at: new Date(), revoked_reason: reason })
      .where('user_id', '=', userId).where('revoked_at', 'is', null).where('mfa_verified_at', 'is', null).execute();
  }

  private async recordAttempt(username: string, ip: string | null, succeeded: boolean, reason: string | null): Promise<void> {
    await this.db.insertInto('login_attempts').values({ username_tried: username.slice(0, 100), ip, succeeded, reason }).execute();
  }

  private async recentFailures(username: string): Promise<number> {
    const r = await this.db.selectFrom('login_attempts').select((eb) => eb.fn.countAll<string>().as('n'))
      .where(sql`lower(username_tried)`, '=', username).where('succeeded', '=', false)
      .where('at', '>', new Date(Date.now() - LOCKOUT_BASE_MS)).executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  private async deliverResetToken(user: { id: string; staff_id: string | null }, token: string): Promise<void> {
    const staff = user.staff_id ? await this.db.selectFrom('staff').select('phone').where('id', '=', user.staff_id).executeTakeFirst() : undefined;
    let notifications: NotificationService | null = null;
    try {
      notifications = this.moduleRef.get<NotificationService>(NOTIFICATION_SERVICE, { strict: false });
    } catch {
      notifications = null;
    }
    if (!staff?.phone || !notifications) {
      this.logger.warn({ userId: user.id }, 'password reset requested but no phone or notification service; administrator must reset instead');
      return;
    }
    await notifications.enqueue('password_reset', [{ staffUserId: user.id, phone: staff.phone }], { resetCode: token, minutes: 30 }, { requestedByUserId: null });
  }
}
