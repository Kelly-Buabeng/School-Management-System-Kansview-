// Owner: Orchestrator. Shared app setup used by main.ts and by integration tests, so tests run the real pipeline.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { ProblemFilter } from './common/problem.filter';
import { requestId } from './common/request-id';
import { parseTrustProxy, type TrustProxySetting } from './common/trust-proxy';

/**
 * @param trustProxy which reverse proxies to believe about the client address (CP5-02). Defaults to
 *   SMS_TRUST_PROXY; production Compose sets 1 so req.ip (rate limits, audit, sessions) is the real client
 *   behind Caddy, not Caddy's container address.
 */
export function configureApp(app: INestApplication, trustProxy: TrustProxySetting = parseTrustProxy(process.env.SMS_TRUST_PROXY)): INestApplication {
  (app.getHttpAdapter().getInstance() as { set(name: string, value: unknown): unknown }).set('trust proxy', trustProxy);
  app.setGlobalPrefix('api/v1');
  app.use(requestId);
  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  return app;
}
