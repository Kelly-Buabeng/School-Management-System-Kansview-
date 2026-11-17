import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { SESSION_RESOLVER } from './auth-user';
import { SCOPE_SERVICE } from './scope.service';
import { FIELD_POLICY } from './field-policy';
import { AUDIT_SERVICE } from './audit.service';
import { FIELD_CRYPTO } from './field-crypto';
import { UPLOAD_PIPELINE } from './upload-pipeline';
import { IDEMPOTENCY_SERVICE } from './idempotency';
import { EnvelopeFieldCrypto } from './field-crypto.service';
import { RoleFieldPolicy } from './field-policy.impl';
import { DbAuditService } from './audit.service.impl';
import { DbIdempotencyService } from './idempotency.impl';
import { DbScopeService } from './scope.service.impl';
import { DbSessionResolver } from './session-resolver.impl';
import { SessionService } from './session.service';
import { HardenedUploadPipeline, FILE_RECORDS } from './upload-pipeline.service';
import { DbFileRecords } from './file-records.repository';
import { PasswordHasher } from './password-hasher';
import { RateLimiter } from './rate-limiter';
import { AuditedInterceptor } from './audited.interceptor';
import { requestContextMiddleware } from './request-context';
import { securityHeaders } from './security-headers';

/** Owner: Agent D. Global so every module can inject security services by token. */
@Global()
@Module({
  providers: [
    { provide: FIELD_CRYPTO, useClass: EnvelopeFieldCrypto },
    SessionService,
    PasswordHasher,
    RateLimiter,
    { provide: SESSION_RESOLVER, useClass: DbSessionResolver },
    { provide: SCOPE_SERVICE, useClass: DbScopeService },
    { provide: FIELD_POLICY, useClass: RoleFieldPolicy },
    { provide: AUDIT_SERVICE, useClass: DbAuditService },
    { provide: FILE_RECORDS, useClass: DbFileRecords },
    { provide: UPLOAD_PIPELINE, useClass: HardenedUploadPipeline },
    { provide: IDEMPOTENCY_SERVICE, useClass: DbIdempotencyService },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditedInterceptor },
  ],
  exports: [
    SESSION_RESOLVER, SCOPE_SERVICE, FIELD_POLICY, AUDIT_SERVICE, FIELD_CRYPTO, UPLOAD_PIPELINE, IDEMPOTENCY_SERVICE,
    SessionService, PasswordHasher, RateLimiter,
  ],
})
export class SecurityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware, securityHeaders).forRoutes('*');
  }
}
