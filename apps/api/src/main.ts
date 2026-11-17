// Owner: Orchestrator.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './common/config';
import { logger } from './common/logger';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  configureApp(app);
  await app.listen(cfg.SMS_PORT);
  logger.info({ port: cfg.SMS_PORT }, 'api listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
