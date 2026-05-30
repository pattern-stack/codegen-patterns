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
import { JobsDomainModule, JobWorkerModule } from '@shared/subsystems/jobs';
import { CacheModule } from '@shared/subsystems/cache';
import { StorageModule } from '@shared/subsystems/storage';
import { IntegrationModule } from '@shared/subsystems/integration';
import { BridgeModule, BRIDGE_RESERVED_POOLS } from '@shared/subsystems/bridge';
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
    // 4. jobs — domain layer + worker loop
    JobsDomainModule.forRoot({ backend: 'drizzle' }),
    JobWorkerModule.forRoot({
      mode: 'embedded',
      backend: 'drizzle',
      // include the bridge's reserved pools so wrappers actually drain:
      pools: ['interactive', 'batch', ...BRIDGE_RESERVED_POOLS],
    }),
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
| `JobsDomainModule` | `forRoot({ backend, multiTenant?, extensions? })` | `backend: 'drizzle' \| 'memory' \| 'bullmq'`. Domain layer (orchestrator, run/step services). `extensions.bullmq` / `extensions.drizzle` are the opt-in backend extras. |
| `JobWorkerModule` | `forRoot({ mode, backend?, pools?, allPools?, shutdownTimeoutMs? })` | `mode: 'embedded' \| 'standalone'`. `pools` = active pool names this process drains (defaults to all non-reserved). `allPools: true` drains every pool incl. reserved. |
| `CacheModule` | `forRoot({ backend })` | optionally registers a cleanup job when jobs is present. |
| `StorageModule` | `forRoot({ backend })` | `backend: 'local' \| 'memory'`. Implement S3/GCS by implementing the storage protocol. |
| `IntegrationModule` | `forRoot({ backend, multiTenant? })` | wires the cursor store / run recorder / differ ports — NOT the orchestrator (that's per-entity; see the `integration` skill). |
| `BridgeModule` | `forRoot({ backend, multiTenant? })` | must come after events + jobs; fails fast at boot if reserved pools aren't polled. |
| `ObservabilityModule` | `forRoot({ reporters? })` | read-only facade; `reporters.bridgeMetrics: true` opts into the 60s bridge sampler. Register last. |
| `AuthModule` | `forRoot({ encryptionKey, oauthStateStore })` | `global: true`; provides `ENCRYPTION_KEY` + `OAUTH_STATE_STORE`. Register before `IntegrationsAuthModule`. |

## Pool configuration (jobs)

Pool *definitions* live in `codegen.config.yaml`, not in `forRoot`:

```yaml
jobs:
  backend: drizzle
  pools:
    - { name: interactive, concurrency: 8 }
    - { name: batch,       concurrency: 2 }
    # the bridge's reserved lanes (events_inbound/_change/_outbound) are
    # provided by BRIDGE_RESERVED_POOLS — see the bridge skill
```

`JobWorkerModule.forRoot({ pools })` then names which of those a given worker
process drains — scale horizontally by running one worker per pool subset.

## Multi-tenancy opt-in (events / jobs / integration / bridge)

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

- **bridge → events + jobs.** The bridge claims `domain_events` rows and starts
  wrapper job runs in the reserved pools. Without events + jobs registered (and
  the reserved pools polled) it has nothing to consume and nowhere to write.
- **observability → events/jobs/bridge/integration (optional).** It composes the read
  ports of whatever siblings exist, via optional DI. Register it last so those
  ports are already bound; missing siblings are simply omitted from its output.
- **auth-integrations → auth.** The integration adapters need the encryption key
  + token provided by `AuthModule`.

Until the CLI enforces this graph, treat this file as the source of truth and
keep `app.module.ts` in the order above.
