// Owner: Orchestrator. Shared app setup used by main.ts and by integration tests, so tests run the real pipeline.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { ProblemFilter } from './common/problem.filter';
import { requestId } from './common/request-id';

export function configureApp(app: INestApplication): INestApplication {
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
