---
to: "<%= workerPath %>"
unless_exists: true
---
/**
 * Standalone job worker entrypoint — emitted by `codegen subsystem install jobs`.
 *
 * Boots a Nest application context (NO HTTP listener) that composes the
 * consumer's root `AppModule` plus `JobWorkerModule.forRoot({ mode:
 * 'standalone', allPools: true, … })`. Run with:
 *
 *   bun src/worker.ts
 *
 * Why import `AppModule` whole:
 *   - Job handlers are Nest providers registered by the consumer's handler
 *     modules (and the subsystem barrel). Composing around `AppModule` gives
 *     this worker the SAME DI graph as the HTTP process — every `@JobHandler`
 *     resolves its dependencies here exactly as it would in the API. A bare
 *     `SUBSYSTEM_MODULES`-only worker boots with an empty handler surface.
 *   - `AppModule` already wires `DatabaseModule` + `SUBSYSTEM_MODULES` (events +
 *     jobs + bridge + integration, dependency-ordered), so the worker needs no
 *     mode-aware barrel import — only `JobWorkerModule` itself.
 *
 * Why `allPools: true`:
 *   - The events subsystem's outbox drain and the bridge's fanout wrappers run
 *     as `job_run` rows in the RESERVED `events_*` pools. A worker that only
 *     polls the non-reserved pools (`interactive`, `batch`, …) strands those
 *     lanes — `BridgeDeliveryHandler` never fires and durable event→job fanout
 *     silently stops.
 *   - `allPools: true` activates every pool in the resolved config, reserved
 *     lanes included, so this single standalone process drains both user work
 *     and the framework's reserved lanes.
 *
 * STANDALONE ONLY: this entrypoint is for `jobs.worker_mode: standalone`. In
 * embedded mode the worker already runs inside `AppModule` (via the
 * `JobWorkerModule.forRoot({ mode: 'embedded' })` the barrel composes), so
 * booting this file too would double-spawn the worker against the same pools.
 *
 * DO NOT boot `AppModule` twice in one process: a consumer `AppModule`
 * registers an OpenAPI document against the per-process `OpenApiRegistry`
 * singleton, which throws `DuplicateSchemaError` on the second registration.
 * Multi-rung boot validation (e.g. "does the worker boot AND does the API
 * boot?") must spawn CHILD PROCESSES, not import both modules into one.
 *
 * SIGTERM triggers graceful shutdown bounded by SHUTDOWN_TIMEOUT_MS; after the
 * timeout the process exits hard so orchestrators (systemd, Kubernetes) can
 * reclaim the slot.
 */
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { JobWorkerModule } from '<%= jobWorkerModuleImport %>';

const SHUTDOWN_TIMEOUT_MS = 30_000;

@Module({
  imports: [
    // Consumer root — DatabaseModule + SUBSYSTEM_MODULES + handler modules.
    // Importing it whole keeps the worker's DI graph identical to the HTTP app's
    // so every `@JobHandler` resolves the same way in both processes.
    AppModule,
    // `allPools: true` drains the reserved `events_*` lanes (events outbox +
    // bridge wrappers) alongside the user pools.
    JobWorkerModule.forRoot(<%- workerForRootOpts %>),
  ],
})
export class WorkerAppModule {}

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

// Gated so the module can be imported by boot-checks / e2e without spawning a
// worker; `bun src/worker.ts` runs it as the entrypoint.
if (import.meta.main) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('failed to bootstrap job worker', err);
    process.exit(1);
  });
}
