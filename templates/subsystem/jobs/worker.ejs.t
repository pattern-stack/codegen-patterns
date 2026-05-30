---
to: "<%= workerPath %>"
unless_exists: true
---
/**
 * Standalone job worker entrypoint — emitted by `codegen subsystem install jobs`.
 *
 * Boots a Nest application context (NO HTTP listener) wiring the full
 * subsystem barrel (`SUBSYSTEM_MODULES` — events + jobs + bridge + integration, in
 * dependency order) plus `JobWorkerModule.forRoot({ mode: 'standalone',
 * allPools: true })`. Run with:
 *
 *   bun worker.ts
 *
 * Why the barrel + `allPools`:
 *   - The events subsystem's outbox drain and the bridge's fanout wrappers
 *     run as `job_run` rows in the RESERVED `events_*` pools. A worker that
 *     only polls the non-reserved pools (`interactive`, `batch`, …) leaves
 *     those lanes stranded — `BridgeDeliveryHandler` never fires and durable
 *     event→job fanout silently stops.
 *   - `allPools: true` activates every pool in the resolved config, reserved
 *     lanes included, so this single standalone process drains both user work
 *     and the framework's reserved lanes.
 *   - Importing `SUBSYSTEM_MODULES` (rather than `JobsDomainModule` alone)
 *     registers `EVENT_BUS` / `JOB_ORCHESTRATOR` / `BRIDGE_*` so the
 *     framework `@framework/bridge_delivery` handler resolves its DI deps.
 *     `BridgeModule`'s reserved-pool guard short-circuits to pass because
 *     `allPools` is set.
 *
 * Embedded mode (single-process) is configured by importing
 * `JobWorkerModule.forRoot({ mode: 'embedded' })` inside AppModule instead —
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
import { JobWorkerModule } from '@shared/subsystems/jobs/job-worker.module';
import { SUBSYSTEM_MODULES } from '@generated/subsystems';

const SHUTDOWN_TIMEOUT_MS = 30_000;

@Module({
  imports: [
    DatabaseModule,
    // Events + Jobs + Bridge + Integration (dependency-ordered) from the generated
    // barrel. This is the same composition AppModule imports — keeping the
    // worker's DI graph identical to the HTTP app's so handlers resolve the
    // same way in both processes.
    ...SUBSYSTEM_MODULES,
    // `allPools: true` drains the reserved `events_*` lanes (events outbox +
    // bridge wrappers) alongside the user pools.
    JobWorkerModule.forRoot({ mode: 'standalone', allPools: true }),
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

  logger.log('job worker started (standalone mode, all pools)');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('failed to bootstrap job worker', err);
  process.exit(1);
});
