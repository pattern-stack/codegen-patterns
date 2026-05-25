/**
 * JobsDomainModule — `DynamicModule.forRoot({ backend })` factory wiring
 * the three jobs-domain protocol tokens to a backend implementation
 * (ADR-022, JOB-5).
 *
 * Mirrors `EventsModule.forRoot()` exactly:
 *   - `global: true` so consumer entity modules don't have to import this
 *     individually — `JOB_ORCHESTRATOR` / `JOB_RUN_SERVICE` /
 *     `JOB_STEP_SERVICE` are available project-wide.
 *   - One backend at a time (Drizzle for production, Memory for tests).
 *
 * Backend swappability follows the core/extension protocol from CLAUDE.md:
 * the three tokens are the **core contract**; backend-specific tunables
 * live under `extensions.<backend>` so opting into a feature is explicit
 * and the type system reserves the slot.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
  JOBS_MULTI_TENANT,
} from './jobs-domain.tokens';
import { DrizzleJobOrchestrator } from './job-orchestrator.drizzle-backend';
import { DrizzleJobRunService } from './job-run-service.drizzle-backend';
import { DrizzleJobStepService } from './job-step-service.drizzle-backend';
import { BullMQJobOrchestrator } from './job-orchestrator.bullmq-backend';
import { MemoryJobOrchestrator } from './job-orchestrator.memory-backend';
import { MemoryJobRunService } from './job-run-service.memory-backend';
import { MemoryJobStepService } from './job-step-service.memory-backend';
import { MemoryJobStore } from './memory-job-store';
import {
  BULLMQ_CONNECTION,
  BULLMQ_RESOLVED_CONFIG,
  resolveBullMqConfig,
  type BullMqExtensionsConfig,
} from './bullmq.config';

/**
 * Drizzle backend extensions surface. None are wired into the Drizzle
 * orchestrator yet — this is the **typed reservation** for the LISTEN/NOTIFY
 * + tunable poll-interval extensions called out in ADR-022. App code
 * passing these today is parsed but not yet dispatched; when the
 * Drizzle orchestrator grows the consumer hooks, opt-in code paths will
 * read directly from these fields.
 */
export interface DrizzleBackendExtensions {
  /** Use Postgres LISTEN/NOTIFY to wake the polling loop. Default false. */
  listenNotify?: boolean;
  /** Polling interval when LISTEN/NOTIFY is off (ms). Default 1000. */
  pollIntervalMs?: number;
}

export interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory' | 'bullmq';
  /**
   * Backend-specific extensions. Only the matching backend's extensions
   * are read at boot; non-matching keys are ignored. This is the
   * core/extension protocol surface — see CLAUDE.md.
   */
  extensions?: {
    drizzle?: DrizzleBackendExtensions;
    /**
     * BullMQ backend extensions (BULLMQ-1). Snake_case mirrors the YAML
     * under `jobs.extensions.bullmq`. `redis_url` falls back to
     * `process.env.REDIS_URL` then `redis://localhost:6379`.
     */
    bullmq?: BullMqExtensionsConfig;
  };
  /** Multi-tenancy opt-in. Wired by JOB-8; module signature stays stable. */
  multiTenant?: boolean;
}

@Module({})
export class JobsDomainModule {
  static forRoot(opts: JobsDomainModuleOptions): DynamicModule {
    const multiTenant = opts.multiTenant ?? false;

    const providers: Provider[] = [
      // JOB-8 — boolean provider consumed by the four service-layer backends.
      // Always provided (even when `multiTenant === false`) so `@Inject`
      // always resolves; backends short-circuit the enforcement path when
      // the value is `false`. See `jobs-domain.tokens.ts` for the claim-loop
      // cross-tenant-by-design decision.
      { provide: JOBS_MULTI_TENANT, useValue: multiTenant },
    ];

    if (opts.backend === 'memory') {
      // The store is a plain class — wired as a singleton `useValue` so
      // unit tests can pull it out via `.get(MemoryJobStore)` for direct
      // assertions (matches the access pattern in JOB-4 specs).
      const store = new MemoryJobStore();
      providers.push({ provide: MemoryJobStore, useValue: store });
      providers.push(MemoryJobStepService);
      providers.push({ provide: JOB_STEP_SERVICE, useExisting: MemoryJobStepService });
      providers.push(MemoryJobOrchestrator);
      providers.push({ provide: JOB_ORCHESTRATOR, useExisting: MemoryJobOrchestrator });
      providers.push(MemoryJobRunService);
      providers.push({ provide: JOB_RUN_SERVICE, useExisting: MemoryJobRunService });
    } else if (opts.backend === 'bullmq') {
      // BULLMQ-1 — BullMQ orchestrator over a Postgres source of truth. The
      // run/step services stay Drizzle (domain reads + `listForScope` are
      // Postgres queries, unchanged per spec). Only the orchestrator's
      // claim/dispatch half swaps to BullMQ.
      const resolved = resolveBullMqConfig(opts.extensions?.bullmq);
      providers.push({ provide: BULLMQ_CONNECTION, useValue: resolved.connection });
      providers.push({ provide: BULLMQ_RESOLVED_CONFIG, useValue: resolved });
      providers.push({ provide: JOB_ORCHESTRATOR, useClass: BullMQJobOrchestrator });
      providers.push({ provide: JOB_RUN_SERVICE, useClass: DrizzleJobRunService });
      providers.push({ provide: JOB_STEP_SERVICE, useClass: DrizzleJobStepService });
    } else {
      providers.push({ provide: JOB_ORCHESTRATOR, useClass: DrizzleJobOrchestrator });
      providers.push({ provide: JOB_RUN_SERVICE, useClass: DrizzleJobRunService });
      providers.push({ provide: JOB_STEP_SERVICE, useClass: DrizzleJobStepService });
    }

    const exports = [
      JOB_ORCHESTRATOR,
      JOB_RUN_SERVICE,
      JOB_STEP_SERVICE,
      JOBS_MULTI_TENANT,
    ];
    // BULLMQ-1 — only export the BullMQ tokens when they were actually
    // provided. Nest throws "exported but not provided" otherwise. Exported so
    // JobWorkerModule (which imports this module) can read the resolved
    // connection/config to spawn BullMQ workers.
    if (opts.backend === 'bullmq') {
      exports.push(BULLMQ_CONNECTION, BULLMQ_RESOLVED_CONFIG);
    }

    return {
      module: JobsDomainModule,
      global: true,
      providers,
      exports,
    };
  }
}
