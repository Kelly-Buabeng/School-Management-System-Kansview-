// Owner: Agent F. Like test/support/test-app.ts, but lets Agent F tests swap more providers (scope, lookups, provider).
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { SESSION_RESOLVER, type AuthUser } from '../../src/security/auth-user';

export interface FTestApp {
  app: INestApplication;
  currentUser: { value: AuthUser | null };
}

export async function createFTestApp(
  dbUrl: string,
  overrides: Array<{ token: unknown; value: unknown }> = [],
  env: Record<string, string> = {},
): Promise<FTestApp> {
  process.env.SMS_DB_URL = dbUrl;
  process.env.SMS_NODE_ENV = 'test';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const currentUser: { value: AuthUser | null } = { value: null };
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SESSION_RESOLVER)
    .useValue({ resolve: async () => currentUser.value });
  for (const o of overrides) builder = builder.overrideProvider(o.token as never).useValue(o.value);
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return { app, currentUser };
}
