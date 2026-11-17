// Owner: Orchestrator (entrypoint). Job handlers are registered by Agent F (notifications, PDFs, exports) and others
// through a WorkerModule they add under their own module folder. Runs as a separate process: `node dist/worker.js`.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logger } from './common/logger';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  logger.info('worker started');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
