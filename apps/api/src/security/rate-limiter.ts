import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../common/app-error';

/**
 * Sliding-window rate limiter kept in memory. Suitable for the single-server deployment (one API process).
 * Account lockout does not depend on this: it is stored in the users table and survives restarts.
 * If the API is ever run as several processes, replace with a PostgreSQL-backed implementation of the same class.
 */
export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  loginPerIpUser: { limit: 10, windowMs: 15 * 60_000 },
  loginPerIp: { limit: 50, windowMs: 15 * 60_000 },
  mfaPerSession: { limit: 10, windowMs: 15 * 60_000 },
  resetPerIp: { limit: 10, windowMs: 60 * 60_000 },
  resetPerAccount: { limit: 3, windowMs: 60 * 60_000 },
  searchPerUser: { limit: 120, windowMs: 60_000 },
  exportPerUser: { limit: 20, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitRule>;

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly hits = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  consume(key: string, rule: RateLimitRule, now = Date.now()): RateLimitDecision {
    const since = now - rule.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= rule.limit) {
      this.hits.set(key, list);
      const retryAfterSeconds = Math.max(1, Math.ceil((list[0]! + rule.windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, remaining: rule.limit - list.length, retryAfterSeconds: 0 };
  }

  /** Throws 429 RATE_LIMITED when over the limit; sets Retry-After on `res` when given. */
  enforce(key: string, rule: RateLimitRule, res?: { setHeader(name: string, value: string): unknown }, now = Date.now()): void {
    const d = this.consume(key, rule, now);
    if (!d.allowed) {
      res?.setHeader('Retry-After', String(d.retryAfterSeconds));
      throw new AppError(429, ErrorCodes.RATE_LIMITED, 'Too many attempts. Please wait and try again.',
        `Try again in about ${Math.ceil(d.retryAfterSeconds / 60)} minute(s).`, undefined, { retryAfterSeconds: d.retryAfterSeconds });
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Clears all counters (tests, or an administrator after an incident). */
  resetAll(): void {
    this.hits.clear();
  }

  private sweep(now = Date.now()): void {
    const maxWindow = Math.max(...Object.values(RATE_LIMITS).map((r) => r.windowMs));
    for (const [k, v] of this.hits) {
      if (v.length === 0 || v[v.length - 1]! < now - maxWindow) this.hits.delete(k);
    }
  }
}
