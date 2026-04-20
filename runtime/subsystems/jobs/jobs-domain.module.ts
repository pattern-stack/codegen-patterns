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
import { MemoryJobOrchestrator } from './job-orchestrator.memory-backend';
import { MemoryJobRunService } from './job-run-service.memory-backend';
import { MemoryJobStepService } from './job-step-service.memory-backend';
import { MemoryJobStore } from './memory-job-store';

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

// Phase 6+ — typed-but-unimplemented BullMQ extension slot. Kept as a
// commented-out interface to make the future shape discoverable without
// shipping dead runtime code. Per CLAUDE.md "no feature-flag-guarded dead
// code" we don't ship the option in `JobsDomainModuleOptions.extensions`
// either; flip it on when JOB-Phase-6 lands the BullMQ orchestrator.
//
// export interface BullMqBackendExtensions {
//   bullBoard?: { enabled: boolean; mountPath?: string };
//   redisUrl?: string;
// }

export interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory';
  /**
   * Backend-specific extensions. Only the matching backend's extensions
   * are read at boot; non-matching keys are ignored. This is the
   * core/extension protocol surface — see CLAUDE.md.
   */
  extensions?: {
    drizzle?: DrizzleBackendExtensions;
    // bullmq?: BullMqBackendExtensions;   // Phase 6+
  };
  /** Multi-tenancy opt-in. Wired by JOB-8; module signature stays stable. */
  multiTenant?: boolean;
}

@Module({})
export class JobsDomainModule {
  static forRoot(opts: JobsDomainModuleOptions): DynamicModule {
    void opts.extensions; // typed reservation; consumed by Phase 6+ wiring

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
    } else {
      providers.push({ provide: JOB_ORCHESTRATOR, useClass: DrizzleJobOrchestrator });
      providers.push({ provide: JOB_RUN_SERVICE, useClass: DrizzleJobRunService });
      providers.push({ provide: JOB_STEP_SERVICE, useClass: DrizzleJobStepService });
    }

    return {
      module: JobsDomainModule,
      global: true,
      providers,
      exports: [
        JOB_ORCHESTRATOR,
        JOB_RUN_SERVICE,
        JOB_STEP_SERVICE,
        JOBS_MULTI_TENANT,
      ],
    };
  }
}
