import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { KYSELY, type Db } from '../common/db/database.module';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { FIELD_CRYPTO } from './field-crypto';
import type { FieldCryptoEngine } from './field-crypto.service';
import type { Role } from './permissions';
import { readFileSync } from 'node:fs';

export const SESSION_COOKIE = '__Host-sms_session';
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
/** Roles that may not use the system without MFA (rbac.md). */
export const MFA_REQUIRED_ROLES: readonly Role[] = ['ADMIN', 'BURSAR'];

/**
 * Where a signed-in session is in the login journey. Only `full` sessions may use normal routes.
 * - mfa_pending: password accepted, TOTP not yet entered
 * - mfa_enrolment: ADMIN/BURSAR without MFA must enrol first
 * - password_change: temporary password must be changed first
 */
export type SessionPhase = 'mfa_pending' | 'mfa_enrolment' | 'password_change' | 'full';

export function sessionPhase(u: { mfa_enabled: boolean; roles: string[]; must_change_password: boolean }, s: { mfa_verified_at: Date | string | null }): SessionPhase {
  if (u.mfa_enabled && !s.mfa_verified_at) return 'mfa_pending';
  if (!u.mfa_enabled && u.roles.some((r) => (MFA_REQUIRED_ROLES as string[]).includes(r))) return 'mfa_enrolment';
  if (u.must_change_password) return 'password_change';
  return 'full';
}

export function hashSessionId(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface NewSession {
  rawId: string;
  hash: string;
  expiresAt: Date;
}

/**
 * Server-side sessions in app.user_sessions. The cookie holds 256 random bits (base64url);
 * the table stores only its SHA-256, so a database leak does not leak usable sessions.
 */
@Injectable()
export class SessionService {
  private readonly csrfKey: Buffer;

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    @Inject(APP_CONFIG) cfg: AppConfig,
    @Inject(FIELD_CRYPTO) crypto: FieldCryptoEngine,
  ) {
    this.csrfKey = cfg.SMS_SESSION_SECRET_FILE
      ? createHash('sha256').update(readFileSync(cfg.SMS_SESSION_SECRET_FILE)).digest()
      : typeof crypto.deriveKey === 'function'
        ? crypto.deriveKey('sms-csrf-v1')
        : randomBytes(32);
  }

  async create(userId: string, opts: { ip: string | null; userAgent: string | null; mfaVerified: boolean }, db: Db = this.db): Promise<NewSession> {
    const rawId = randomBytes(32).toString('base64url');
    const hash = hashSessionId(rawId);
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_ABSOLUTE_MS);
    await db.insertInto('user_sessions').values({
      id: hash,
      user_id: userId,
      expires_at: expiresAt,
      idle_expires_at: new Date(Math.min(now + SESSION_IDLE_MS, expiresAt.getTime())),
      ip: opts.ip,
      user_agent: opts.userAgent,
      mfa_verified_at: opts.mfaVerified ? new Date(now) : null,
    }).execute();
    return { rawId, hash, expiresAt };
  }

  /** Revokes the old session and issues a new id (session fixation defence on login and after MFA). */
  async rotate(oldHash: string, userId: string, opts: { ip: string | null; userAgent: string | null; mfaVerified: boolean }, reason: string): Promise<NewSession> {
    return this.db.transaction().execute(async (tx) => {
      await this.revoke(oldHash, reason, tx);
      return this.create(userId, opts, tx);
    });
  }

  async revoke(hash: string, reason: string, db: Db = this.db): Promise<void> {
    await db.updateTable('user_sessions').set({ revoked_at: new Date(), revoked_reason: reason }).where('id', '=', hash).where('revoked_at', 'is', null).execute();
  }

  async revokeAllForUser(userId: string, reason: string, exceptHash?: string, db: Db = this.db): Promise<number> {
    let q = db.updateTable('user_sessions').set({ revoked_at: new Date(), revoked_reason: reason }).where('user_id', '=', userId).where('revoked_at', 'is', null);
    if (exceptHash) q = q.where('id', '<>', exceptHash);
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  /**
   * Looks up a live session and slides its idle timeout. Returns null when the session does not exist,
   * was revoked, or is past its idle/absolute expiry ('expired' distinguishes timeouts for a clearer message).
   */
  async touch(rawId: string): Promise<{ status: 'ok'; session: { id: string; user_id: string; mfa_verified_at: Date | null; expires_at: Date } } | { status: 'expired' | 'missing' }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawId)) return { status: 'missing' };
    const hash = hashSessionId(rawId);
    const row = await this.db.selectFrom('user_sessions').select(['id', 'user_id', 'mfa_verified_at', 'expires_at', 'idle_expires_at', 'revoked_at']).where('id', '=', hash).executeTakeFirst();
    if (!row || row.revoked_at) return { status: 'missing' };
    const now = Date.now();
    const expiresAt = new Date(row.expires_at);
    if (new Date(row.idle_expires_at).getTime() <= now || expiresAt.getTime() <= now) {
      await this.revoke(hash, 'expired');
      return { status: 'expired' };
    }
    await this.db.updateTable('user_sessions')
      .set({ last_seen_at: sql<Date>`now()`, idle_expires_at: new Date(Math.min(now + SESSION_IDLE_MS, expiresAt.getTime())) })
      .where('id', '=', hash).execute();
    return { status: 'ok', session: { id: row.id, user_id: row.user_id, mfa_verified_at: row.mfa_verified_at ? new Date(row.mfa_verified_at) : null, expires_at: expiresAt } };
  }

  // ---------------- CSRF (synchroniser token bound to the session) ----------------

  csrfToken(sessionHash: string): string {
    return createHmac('sha256', this.csrfKey).update(`csrf:${sessionHash}`).digest('base64url');
  }

  verifyCsrf(sessionHash: string, token: unknown): boolean {
    if (typeof token !== 'string' || token.length === 0 || token.length > 100) return false;
    const a = Buffer.from(this.csrfToken(sessionHash));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  cookieOptions(expiresAt: Date) {
    return { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/', expires: expiresAt };
  }
}
