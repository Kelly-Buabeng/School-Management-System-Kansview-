import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { SESSION_RESOLVER } from './auth-user';
import { SCOPE_SERVICE } from './scope.service';
import { FIELD_POLICY } from './field-policy';
import { AUDIT_SERVICE } from './audit.service';
import { FIELD_CRYPTO } from './field-crypto';
import { UPLOAD_PIPELINE } from './upload-pipeline';
import { IDEMPOTENCY_SERVICE } from './idempotency';
import {
  DevFieldCrypto, LoggingAuditService, NoStoreIdempotencyService, NotReadyUploadPipeline,
  PassThroughFieldPolicy, StubScopeService, StubSessionResolver,
} from './stubs';

/** Owner: Agent D. Global so every module can inject security services by token. */
@Global()
@Module({
  providers: [
    { provide: SESSION_RESOLVER, useClass: StubSessionResolver },
    { provide: SCOPE_SERVICE, useClass: StubScopeService },
    { provide: FIELD_POLICY, useClass: PassThroughFieldPolicy },
    { provide: AUDIT_SERVICE, useClass: LoggingAuditService },
    { provide: FIELD_CRYPTO, useClass: DevFieldCrypto },
    { provide: UPLOAD_PIPELINE, useClass: NotReadyUploadPipeline },
    { provide: IDEMPOTENCY_SERVICE, useClass: NoStoreIdempotencyService },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [SESSION_RESOLVER, SCOPE_SERVICE, FIELD_POLICY, AUDIT_SERVICE, FIELD_CRYPTO, UPLOAD_PIPELINE, IDEMPOTENCY_SERVICE],
})
export class SecurityModule {}
