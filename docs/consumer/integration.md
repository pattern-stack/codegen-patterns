# Consumer Setup — Integration subsystem

> Part of the [Consumer Setup](../CONSUMER-SETUP.md) reference, split out for focused reading. In-project coding agents get the same material (progressively disclosed) from the `integration` skill under `.claude/skills/`.

## Integration subsystem

The integration subsystem (epic #60) ships a generic external-system integration engine:
the `IChangeSource<T>` port (one seam for poll / CDC / webhook detection
modes), `ExecuteIntegrationUseCase<T>` (the one orchestrator the whole codebase
runs on), a structured per-field `changed_fields` audit log (ADR-0003),
Drizzle + Memory backends for the cursor store and run recorder, and a
default `DeepEqualDiffer` with a canonical ignore list.

### Install

```bash
codegen subsystem install integration
# or: bun /path/to/codegen-patterns/src/cli/index.ts subsystem install integration
```

This copies the runtime files into `<paths.subsystems>/integration/` (defaulting
to `shared/subsystems/integration/`) and additionally:

- Injects an `integration:` block into `codegen.config.yaml`:
  ```yaml
  integration:
    backend: drizzle
    multi_tenant: false
  ```
- Writes `integration-audit.schema.ts` via a Hygen template (the runtime file is
  skipped by `copyRuntime`). This template owns the scaffold-time
  `tenant_id` conditional — columns on `integration_subscriptions`, `integration_runs`,
  and `integration_run_items` are emitted only when `integration.multi_tenant: true`.

Switch the backend with `--backend memory` (useful in tests); the default
is `drizzle`. Unlike events, the integration scaffold has **no `generated/`
directory** — integration ships no codegen-emitted artifacts. Typed integration
bindings per entity will arrive with the epic's Phase 2 (`integration:` YAML
block), gated on the App-Defined Patterns RFC.

### Register `IntegrationModule` in `AppModule`

```ts
import { IntegrationModule } from '@shared/subsystems/integration/integration.module';

@Module({
  imports: [
    DatabaseModule,
    IntegrationModule.forRoot({ backend: 'drizzle' }),
    // ... other subsystems, GENERATED_MODULES, etc.
  ],
})
export class AppModule {}
```

`IntegrationModule` is `global: true` and wires four ports — `INTEGRATION_CURSOR_STORE`,
`INTEGRATION_RUN_RECORDER`, `INTEGRATION_FIELD_DIFFER`, plus the `INTEGRATION_MULTI_TENANT`
flag — and nothing else. It intentionally does NOT provide
`ExecuteIntegrationUseCase`; the orchestrator depends on `INTEGRATION_CHANGE_SOURCE`
and `INTEGRATION_SINK`, which are per-entity and consumer-owned. Providing the
orchestrator in `IntegrationModule` would force Nest to resolve those tokens at
module compile time, which fails before your feature module is imported.

Options:

- `backend: 'drizzle' | 'memory'` — matches `integration.backend` in your config;
  tests typically override to `'memory'`.
- `multiTenant: true` — opt-in multi-tenancy (see below).

### Per-entity feature module

For each canonical entity you integrate, write a feature module that binds your
adapter (`IChangeSource<T>`), your sink (`IIntegrationSink<T>`), and the
orchestrator class itself:

```ts
import { Module } from '@nestjs/common';
import {
  ExecuteIntegrationUseCase,
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_SINK,
} from '@shared/subsystems/integration';

@Module({
  providers: [
    { provide: INTEGRATION_CHANGE_SOURCE, useClass: SalesforceOpportunityChangeSource },
    { provide: INTEGRATION_SINK,          useClass: OpportunityIntegrationSink },
    ExecuteIntegrationUseCase,
  ],
  exports: [ExecuteIntegrationUseCase],
})
export class OpportunityIntegrationModule {}
```

Consumers inject `ExecuteIntegrationUseCase<CanonicalOpportunity>` wherever they
want to trigger a run — a scheduled job, a CLI command, a webhook
handler, an operator UI button.

### `detection:` block — provider-keyed codegen factory module

The entity-YAML `detection:` block (ADR-033.1) declares one
`DetectionConfig` per integration provider. Codegen emits exactly one
`<entity>-integration-source.module.ts` per entity, regardless of provider
count.

```yaml
# entities/opportunity.yaml
integration:
  providers:
    hubspot-crm: { remote_entity: deal,        direction: inbound }
    salesforce-crm: { remote_entity: Opportunity, direction: inbound }

detection:
  hubspot-crm:
    mode: poll
    poll: { cursor: { kind: timestamp, field: hs_lastmodifieddate } }
    mapping: [ ... ]
    filters: [ ... ]
  salesforce-crm:
    mode: poll
    poll: { cursor: { kind: systemModstamp, field: SystemModstamp } }
    mapping: [ ... ]
    filters: [ ... ]
```

The generated `src/modules/opportunity-integration-source.module.ts` exports
exactly two runtime symbols (plus the module class):

| Token | Type | Direction |
|---|---|---|
| `OPPORTUNITY_POLL_FETCH_REGISTRY` | `Record<string, PollFetchCallback<Opportunity>>` | consumer-supplied |
| `OPPORTUNITY_CHANGE_SOURCES` | `ReadonlyMap<string, IChangeSource<Opportunity>>` | factory output |

The internal `OPPORTUNITY_DETECTION_CONFIGS` const lifts the parsed
YAML into a `Record<string, DetectionConfig>` keyed by provider name.
The factory's `useFactory` iterates `Object.entries` once and calls
`buildChangeSource(cfg, fetches[provider])` for each — no
`isMultiProvider` branch, no per-provider symbols. Adding a provider
to YAML changes the configs map's contents and changes nothing in the
generated symbol space.

Wire the registry in your feature module:

```ts
import { OPPORTUNITY_POLL_FETCH_REGISTRY, OPPORTUNITY_CHANGE_SOURCES, OpportunityIntegrationSourceModule } from '@modules/opportunity-integration-source.module';
import type { OpportunityProvider } from '@modules/opportunity-integration-source.providers';
import { hubspotFetchOpportunities, salesforceFetchOpportunities } from './my-fetches';

@Module({
  imports: [OpportunityIntegrationSourceModule],
  providers: [
    {
      provide: OPPORTUNITY_POLL_FETCH_REGISTRY,
      useValue: {
        'hubspot-crm':    hubspotFetchOpportunities,
        'salesforce-crm': salesforceFetchOpportunities,
      } satisfies Record<OpportunityProvider, PollFetchCallback<Opportunity>>,
    },
  ],
})
export class OpportunityIntegrationWiringModule {}
```

The sibling `<entity>-integration-source.providers.ts` artifact (ADR-033.2)
exports the `<EntityName>Provider` literal-union type — using
`Record<OpportunityProvider, ...>` (or the `satisfies` form above)
turns provider-key typos into compile errors.

### `IChangeSource<T>` — one port, three modes

Three detection modes converge on a single port (ADR rejecting separate
`IPollSource` / `ICdcSource` / `IWebhookSource`, per epic #60). Per-mode
concerns live in `Change<T>` metadata, not in separate ports:

```ts
import type { IChangeSource, Change, IntegrationSubscriptionView } from '@shared/subsystems/integration';

export class SalesforceOpportunityChangeSource
  implements IChangeSource<CanonicalOpportunity>
{
  readonly label = 'salesforce-poll-opportunity';

  async *listChanges(
    _subscription: IntegrationSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpportunity>> {
    const typed = cursor as { systemModstamp?: string } | null;
    const since = typed?.systemModstamp ?? '1970-01-01T00:00:00Z';

    const records = await this.sfdc.query(
      `SELECT ... FROM Opportunity WHERE SystemModstamp > ${since}`,
    );

    for (const r of records) {
      yield {
        externalId: r.Id,
        operation: r.IsDeleted ? 'deleted' : 'updated',
        record: toCanonicalOpportunity(r),
        cursor: { systemModstamp: r.SystemModstamp },
        source: 'poll',
      };
    }
  }
}
```

The orchestrator persists `change.cursor` as the iterator advances; on a
successful run the last-yielded cursor becomes `integration_subscriptions.cursor`
for the next run.

### `IIntegrationSink<T>` — the write surface

One sink per canonical entity. The sink speaks the *canonical* shape
externally; internal mapping (canonical → local columns, EAV dual-write,
FK resolution) stays inside the implementation.

```ts
import type { IIntegrationSink } from '@shared/subsystems/integration';

@Injectable()
export class OpportunityIntegrationSink implements IIntegrationSink<CanonicalOpportunity> {
  async findByExternalId(userId: string, externalId: string) { /* ... */ }
  async upsertByExternalId(userId: string, record: CanonicalOpportunity, provider: string) { /* ... */ }
  async softDeleteByExternalId(userId: string, externalId: string) { /* ... */ }
}
```

### Audit model

Every run produces:

- One `integration_runs` row with `direction` (`inbound|outbound`), `action`
  (`poll|cdc|webhook|manual|writeback`), `status`, counts, cursor
  before/after, and duration.
- One `integration_run_items` row per record processed. `changed_fields` is a
  structured `{ fieldName: { from, to } }` jsonb per ADR-0003 — rejected
  at the recorder if it doesn't parse against `FieldDiffSchema`. This
  means queries like *"when did this opportunity first become Closed
  Won?"* are a one-shot SQL filter, not a payload-JSON scrape.

See `.claude/skills/integration/audit-model.md` for worked query examples and
ADR-0003 rationale.

### Multi-tenancy opt-in

Flip `integration.multi_tenant: true` in `codegen.config.yaml`, then re-run
`subsystem install integration --force --force-config` to re-emit the schema
with `tenant_id` columns on all three tables, and cut an Atlas migration
(see [Atlas migration workflow](../CONSUMER-SETUP.md#atlas-migration-workflow)). Also pass
`multiTenant: true` to `IntegrationModule.forRoot(...)` so the orchestrator and
the Drizzle backends enforce the flag:

```ts
IntegrationModule.forRoot({ backend: 'drizzle', multiTenant: true });
```

With `multiTenant: true`, every `ExecuteIntegrationUseCase.execute(...)` call
MUST pass `tenantId`. The orchestrator's `execute()` method throws
`MissingTenantIdError` at entry BEFORE opening an `integration_runs` row — no
dangling `status=running` rows for rejected inputs. The Drizzle backends
independently re-validate at their write boundary (defense in depth). All
three sites use a shared `assertTenantId` helper so error messages match.

Memory backends (`MemoryCursorStore`, `MemoryRunRecorder`) accept
`tenantId` and record it on their in-memory rows but do not throw —
memory state is process-local; cross-tenant isolation there is not
meaningful. Tests that need per-tenant isolation guarantees target the
Drizzle backends.

### Migration from a bespoke integration pipeline

Consumers already running custom integration code (e.g. the upstream consumer's CRM sync):
see [docs/guides/integration-migration.md](guides/integration-migration.md) for the
step-by-step path.
