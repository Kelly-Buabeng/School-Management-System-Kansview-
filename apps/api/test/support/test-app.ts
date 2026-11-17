// Owner: Orchestrator. Boots the real AppModule against a test database with a fake signed-in user.
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { SESSION_RESOLVER, type AuthUser } from '../../src/security/auth-user';
import { permissionsForRoles, type Role } from '../../src/security/permissions';

export function fakeUser(roles: Role[], overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    username: `test-${roles.join('-').toLowerCase()}`,
    fullName: 'Test User',
    roles,
    permissions: permissionsForRoles(roles),
    sessionId: 'test-session',
    staffId: null,
    mfaVerified: true,
    ...overrides,
  };
}

/**
 * `currentUser.value` can be swapped between requests to test each role.
 * Agent D's real SessionResolver is bypassed here on purpose; auth itself is tested in the auth module.
 */
export async function createTestApp(dbUrl: string, initialUser: AuthUser | null = null): Promise<{ app: INestApplication; currentUser: { value: AuthUser | null } }> {
  process.env.SMS_DB_URL = dbUrl;
  process.env.SMS_NODE_ENV = 'test';
  const currentUser = { value: initialUser };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SESSION_RESOLVER)
    .useValue({ resolve: async () => currentUser.value })
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return { app, currentUser };
}
