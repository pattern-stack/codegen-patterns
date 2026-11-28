---
to: "<%= workerPath %>"
unless_exists: true
---
/**
 * Standalone job worker entrypoint — emitted by `codegen subsystem install jobs` (JOBS-3).
 *
 * With `jobs.worker_mode: standalone` in codegen.config.yaml, the HTTP process composes
 * `JobsEngineModule.forRoot({ worker: false })`: it starts runs but never advances them. This process boots the same
 * `AppModule` (so every job's dependencies resolve as they do in the API) with no HTTP listener, and starts the
 * `@pattern-stack/jobs` in-process executor. Its open-run sweep finds every run the HTTP process (or the event
 * bridge) started. Run more than one: the advance lease keeps one advancer per run. Run with:
 *
 *   bun src/worker.ts
 *
 * SIGTERM / SIGINT close the app, which drains the executor (in-flight steps finish) before exit.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JOBS_EXECUTOR } from '@pattern-stack/jobs/nest';

import { AppModule } from './app.module';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function bootstrap(): Promise<void> {
  const logger = new Logger('JobWorker');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  await app.get<{ start(): Promise<void> }>(JOBS_EXECUTOR).start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received — draining the job executor (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);
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
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  logger.log('job worker started (standalone)');
}

if (import.meta.main) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('failed to bootstrap job worker', err);
    process.exit(1);
  });
}
