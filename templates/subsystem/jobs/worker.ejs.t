---
to: "<%= workerPath %>"
unless_exists: true
---
/**
 * Standalone job worker entrypoint — emitted by `codegen subsystem install jobs`.
 *
 * Boots a Nest application context (NO HTTP listener) wiring the jobs domain
 * module plus JobWorkerModule in `standalone` mode. Run with:
 *
 *   bun worker.ts
 *
 * Embedded mode (single-process) is configured by importing
 * JobWorkerModule.forRoot({ mode: 'embedded' }) inside AppModule instead —
 * see the commented guidance injected into `src/main.ts`.
 *
 * SIGTERM triggers graceful shutdown bounded by SHUTDOWN_TIMEOUT_MS; after the
 * timeout the process exits hard so orchestrators (systemd, Kubernetes) can
 * reclaim the slot.
 */
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { DatabaseModule } from '@shared/database/database.module';
import { JobsDomainModule } from '@shared/subsystems/jobs/jobs-domain.module';
import { JobWorkerModule } from '@shared/subsystems/jobs/job-worker.module';

const SHUTDOWN_TIMEOUT_MS = 30_000;

@Module({
  imports: [
    DatabaseModule,
    JobsDomainModule.forRoot({ backend: 'drizzle' }),
    JobWorkerModule.forRoot({ mode: 'standalone' }),
  ],
})
class WorkerAppModule {}

async function bootstrap(): Promise<void> {
  const logger = new Logger('JobWorker');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: false,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received — shutting down (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

    const forceExit = setTimeout(() => {
      logger.error(`shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await app.close();
      logger.log('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('error during shutdown', err as Error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.log('job worker started (standalone mode)');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('failed to bootstrap job worker', err);
  process.exit(1);
});
