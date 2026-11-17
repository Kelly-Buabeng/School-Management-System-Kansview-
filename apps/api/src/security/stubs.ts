/**
 * SCAFFOLD STUBS so every agent can build and test from day 1.
 * Agent D replaces each of these with the real implementation inside this folder and swaps the binding in security.module.ts.
 * Nothing here is production-safe.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../common/app-error';
import { ErrorCodes } from '@sms/shared';
import type { AuthUser, SessionResolver } from './auth-user';
import type { ScopeService } from './scope.service';
import type { FieldPolicy, PolicyResource } from './field-policy';
import type { AuditEvent, AuditService } from './audit.service';
import type { FieldCrypto } from './field-crypto';
import type { AcceptedFile, IncomingFile, UploadPipeline, UploadPolicy } from './upload-pipeline';
import type { IdempotencyService, IdempotentResult } from './idempotency';

@Injectable()
export class StubSessionResolver implements SessionResolver {
  async resolve(): Promise<AuthUser | null> {
    return null; // nobody is signed in until Agent D lands auth; tests override SESSION_RESOLVER
  }
}

@Injectable()
export class StubScopeService implements ScopeService {
  async allowedClassIds(): Promise<string[] | null> {
    return null;
  }
  async canAccessStudent(): Promise<boolean> {
    return true;
  }
}

@Injectable()
export class PassThroughFieldPolicy implements FieldPolicy {
  apply<T extends Record<string, unknown>>(_r: PolicyResource, dto: T): Partial<T> {
    return dto;
  }
}

@Injectable()
export class LoggingAuditService implements AuditService {
  private readonly logger = new Logger('AuditStub');
  readonly events: Array<AuditEvent & { actorId: string | null }> = [];
  async record(event: AuditEvent, actor: AuthUser | null): Promise<void> {
    this.events.push({ ...event, actorId: actor?.id ?? null });
    this.logger.debug(`${event.action} ${event.entityType} ${event.entityId ?? ''}`);
  }
}

@Injectable()
export class DevFieldCrypto implements FieldCrypto {
  private readonly key = randomBytes(32);
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  decrypt(ciphertext: Buffer): string {
    const d = createDecipheriv('aes-256-gcm', this.key, ciphertext.subarray(0, 12));
    d.setAuthTag(ciphertext.subarray(12, 28));
    return Buffer.concat([d.update(ciphertext.subarray(28)), d.final()]).toString('utf8');
  }
  blindIndex(value: string): Buffer {
    return createHmac('sha256', this.key).update(value).digest();
  }
}

@Injectable()
export class NotReadyUploadPipeline implements UploadPipeline {
  async accept(_f: IncomingFile, _p: UploadPolicy): Promise<AcceptedFile> {
    throw new AppError(501, ErrorCodes.NOT_IMPLEMENTED, 'File uploads are not available yet');
  }
}

@Injectable()
export class NoStoreIdempotencyService implements IdempotencyService {
  async run<T>(key: string | undefined, _route: string, _body: unknown, _user: AuthUser, fn: () => Promise<{ status: number; body: T }>): Promise<IdempotentResult<T>> {
    if (!key) throw new AppError(400, ErrorCodes.IDEMPOTENCY_KEY_REQUIRED, 'Missing Idempotency-Key header');
    const r = await fn();
    return { ...r, replayed: false };
  }
}
