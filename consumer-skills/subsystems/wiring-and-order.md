<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Subsystem wiring & registration order

The exact `forRoot` signatures and a complete `app.module.ts` example. All
modules are `global: true` — register once here; inject the token anywhere.

## Complete `app.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from './shared/database/database.module';
import { GENERATED_MODULES } from './generated/modules';
import { OPENAPI_REGISTRY, OpenApiRegistry } from './shared/openapi';

import { EventsModule } from '@shared/subsystems/events';
import { JobsEngineModule } from '@shared/subsystems/jobs';
import { jobDefinitions } from './generated/jobs';
import { jobLimiters, jobsInProcessOptions } from './generated/app-config';
import { CacheModule } from '@shared/subsystems/cache';
import { StorageModule } from '@shared/subsystems/storage';
import { IntegrationModule } from '@shared/subsystems/integration';
import { BridgeModule } from '@shared/subsystems/bridge';
import { ObservabilityModule } from '@shared/subsystems/observability';

@Global()
@Module({
  providers: [{ provide: OPENAPI_REGISTRY, useValue: new OpenApiRegistry() }],
  exports: [OPENAPI_REGISTRY],
})
class OpenApiModule {}

@Module({
  imports: [
    // 1. database first — provides DRIZZLE
    DatabaseModule,
    // 2. openapi registry singleton
    OpenApiModule,
    // 3. events
    EventsModule.forRoot({ backend: 'drizzle' }),
    // 4. jobs — @pattern-stack/jobs: the registry, the limiters, the in-process executor (worker: true = embedded)
    JobsEngineModule.forRoot({ definitions: jobDefinitions, worker: true, limiters: jobLimiters, inProcess: jobsInProcessOptions }),
    // 5. cache / storage / integration
    CacheModule.forRoot({ backend: 'drizzle' }),
    StorageModule.forRoot({ backend: 'local' }),
    IntegrationModule.forRoot({ backend: 'drizzle' }),
    // 6. bridge — AFTER events + jobs
    BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    // 7. observability — LAST (composes the siblings above)
    ObservabilityModule.forRoot({ reporters: { bridgeMetrics: true } }),
    // 8. your generated entity modules
    ...GENERATED_MODULES,
  ],
})
export class AppModule {}
```

## Per-subsystem `forRoot`

| Module | Signature | Notes |
|---|---|---|
| `EventsModule` | `forRoot({ backend, multiTenant?, pools? })` | `backend: 'drizzle' \| 'memory'`. `pools` restricts this process's drain loop to specific event lanes. |
| `JobsEngineModule` | `forRoot({ definitions, worker, limiters?, inProcess? })` | `@pattern-stack/jobs` on the app's Postgres (JOBS-3). `definitions` = the generated `jobDefinitions` (plain jobs and job factories, whose dependencies it resolves from any module); `worker` runs the executor here; `limiters` / `inProcess` come from the generated app-config. |
| `CacheModule` | `forRoot({ backend })` | optionally registers a cleanup job when jobs is present. |
| `StorageModule` | `forRoot({ backend })` | `backend: 'local' \| 'memory'`. Implement S3/GCS by implementing the storage protocol. |
| `IntegrationModule` | `forRoot({ backend, multiTenant? })` | wires the cursor store / run recorder / differ ports — NOT the orchestrator (that's per-entity; see the `integration` skill). |
| `BridgeModule` | `forRoot({ backend, multiTenant?, registry? })` | must come after events + jobs; its drain hook starts runs with `JobStarter`. |
| `ObservabilityModule` | `forRoot({ reporters? })` | read-only facade; `reporters.bridgeMetrics: true` opts into the 60s bridge sampler. Register last. |
| `AuthModule` | `forRoot({ encryptionKey, oauthStateStore })` | `global: true`; provides `ENCRYPTION_KEY` + `OAUTH_STATE_STORE`. Register before `ConnectionsAuthModule`. |

## Pool configuration (jobs)

Pools live in `codegen.config.yaml` and are generated into `app-config.ts` as limiters, not written in `forRoot`:

```yaml
jobs:
  worker_mode: embedded
  pools:
    batch: { concurrency: 10 }     # interactive (20) and batch (5) always exist
    reports: { concurrency: 2 }
```

A step names its pool as `step({ limiter: 'reports' })`. Every executor runs every pool; scale by adding processes
(`worker_mode: standalone` + `bun src/worker.ts`). See the `jobs` skill.

## Multi-tenancy opt-in (events / integration / bridge)

Three coordinated steps — never a runtime-only toggle:

1. Flip the config flag, e.g. `events.multi_tenant: true` in
   `codegen.config.yaml`.
2. Re-run the install to re-emit the tenancy-aware schema:
   `codegen subsystem install <name> --force --force-config`.
3. Pass `multiTenant: true` to that subsystem's `forRoot(...)`, and cut an Atlas
   migration for the new `tenant_id` column(s).

With `multiTenant: true`, the enforcement sites throw a `MissingTenantIdError`
when a tenant id is required but absent (explicit `null` is allowed for
tenant-less / cross-tenant work).

## Why ordering matters (the dependency graph)

- **bridge → events + jobs.** The bridge's drain hook runs inside the events
  outbox drain and starts runs with the jobs subsystem's `JobStarter`. Without
  events + jobs registered it has nothing to consume and nothing to start.
  (A job run's tenant is its start's; jobs has no `multi_tenant` flag.)
- **observability → events/jobs/bridge/integration (optional).** It composes the read
  ports of whatever siblings exist, via optional DI. Register it last so those
  ports are already bound; missing siblings are simply omitted from its output.
- **auth-integrations → auth.** The integration adapters need the encryption key
  + token provided by `AuthModule`.

Until the CLI enforces this graph, treat this file as the source of truth and
keep `app.module.ts` in the order above.
