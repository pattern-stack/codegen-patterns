<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Change sources, sinks, and feature-module wiring

How you wire a sync integration end to end: the per-entity feature module, the
`IChangeSource<T>` adapter, the `ISyncSink<T>` write surface, the entity-YAML
`detection:` block, triggering runs, multi-tenancy, loopback, and testing.

Everything imports from `@shared/subsystems/sync`.

## The per-entity feature module

`SyncModule.forRoot(...)` in `AppModule` wires the substrate (cursor store, run
recorder, field differ, multi-tenant flag). For **each canonical entity you
sync**, write a feature module that binds:

- `SYNC_CHANGE_SOURCE` — your adapter (one per `(provider, detection-mode, entity)`)
- `SYNC_SINK` — your sink (one per canonical entity)
- `ExecuteSyncUseCase` — the orchestrator class itself
- optionally `SYNC_FIELD_DIFFER` (custom diff rules) and/or
  `SYNC_LOOPBACK_FINGERPRINT_STORE`

```ts
import { Module } from '@nestjs/common';
import {
  ExecuteSyncUseCase,
  SYNC_CHANGE_SOURCE,
  SYNC_SINK,
  SYNC_FIELD_DIFFER,
  DeepEqualDiffer,
} from '@shared/subsystems/sync';

@Module({
  providers: [
    { provide: SYNC_CHANGE_SOURCE, useClass: SalesforceOpportunityChangeSource },
    { provide: SYNC_SINK,          useClass: OpportunitySyncSink },
    // Override the differ per-entity when you need a wider ignore list:
    {
      provide: SYNC_FIELD_DIFFER,
      useValue: new DeepEqualDiffer({ ignore: ['sync_version', 'internal_notes'] }),
    },
    ExecuteSyncUseCase,
  ],
  exports: [ExecuteSyncUseCase],
})
export class OpportunitySyncModule {}
```

**Why `ExecuteSyncUseCase` lives here and not in `SyncModule`:** the
orchestrator depends on `SYNC_CHANGE_SOURCE` + `SYNC_SINK`, which are
per-feature. Nest resolves providers at module compile time; putting the
orchestrator in the global `SyncModule` would require those tokens globally,
which fails until your feature module is imported.

Inject `ExecuteSyncUseCase<CanonicalOpportunity>` wherever you trigger a run —
a scheduled job, a CLI command, a webhook handler, an operator UI button.

## Writing an `IChangeSource<T>`

The one port every adapter implements. The signature is
`listChanges(subscription, cursor): AsyncIterable<Change<T>>`:

```ts
interface IChangeSource<T> {
  readonly label: string;  // e.g. 'salesforce-poll-opportunity'
  listChanges(
    subscription: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>>;
}

interface Change<T> {
  externalId: string;
  operation: 'created' | 'updated' | 'deleted';
  record: T;                           // canonical shape — provider mapping happens in the adapter
  cursor: unknown;                     // typed internally; opaque at the seam
  source: 'poll' | 'cdc' | 'webhook';  // provenance for the run-log audit
  dedupKey?: string;                   // CDC replay_id / webhook event_id when available
  providerChangedFields?: string[];    // CDC-only hint; lets the differ skip untouched fields
}
```

A worked poll adapter:

```ts
import { Injectable } from '@nestjs/common';
import type { IChangeSource, Change, SyncSubscriptionView } from '@shared/subsystems/sync';

@Injectable()
export class SalesforceOpportunityChangeSource
  implements IChangeSource<CanonicalOpportunity>
{
  readonly label = 'salesforce-poll-opportunity';

  constructor(
    private readonly sfdc: SalesforceClient,
    private readonly auth: SalesforceAuthStrategy,
  ) {}

  async *listChanges(
    sub: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpportunity>> {
    const typed = cursor as { systemModstamp?: string } | null;
    const since = typed?.systemModstamp ?? '1970-01-01T00:00:00Z';

    // Auth refresh wraps the upstream call — see rule 3 below.
    const records = await this.auth.withAuthRetry(sub.id, () =>
      this.sfdc.query(
        `SELECT Id, Name, Amount, StageName, SystemModstamp, IsDeleted
         FROM Opportunity
         WHERE SystemModstamp > ${since}
         ORDER BY SystemModstamp ASC`,
      ),
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

**Three rules for adapters:**

1. **Yield `operation: 'updated'` for existing-row changes.** The orchestrator
   computes `'created'` vs `'updated'` itself, based on whether
   `sink.findByExternalId` returns null. Don't pre-compute it in the adapter —
   you have no cheap way to check local state, and duplicating the check wastes
   DB round-trips. Yield `'deleted'` only for genuine upstream deletions.

2. **The cursor must be strictly increasing per yield.** Order by your cursor
   column ASC. If you yield out of cursor order, a mid-run crash persists the
   cursor of the *last-yielded* (not last-successful) record, and the next run
   skips everything between the crash point and that yield.

3. **Auth refresh belongs in the adapter, not the orchestrator.** The
   orchestrator has no notion of session expiry. Wrap upstream client calls
   with a retry-on-auth-fail layer (if you installed the `auth` subsystem, its
   `withAuthRetry` helper is the canonical pattern).

**Cursor shapes are opaque at the seam** — the orchestrator persists
`change.cursor` and never interprets it. Type it however your provider needs
(`{ systemModstamp }`, `{ replayId }`, `{ ts }`, …). **Do not add mode-specific
methods** to `IChangeSource`; if a new mode emerges, add a value to the
`source` union and a metadata field, not a new port.

## Writing an `ISyncSink<T>`

One sink per canonical entity. It speaks the *canonical* shape externally;
internal mapping (canonical → local columns, EAV dual-write, FK resolution)
stays inside:

```ts
interface ISyncSink<TCanonical> {
  findByExternalId(userId: string, externalId: string): Promise<TCanonical | null>;
  upsertByExternalId(userId: string, record: TCanonical, provider: string): Promise<{ id: string; saved: TCanonical }>;
  softDeleteByExternalId(userId: string, externalId: string): Promise<{ id: string } | null>;
}
```

```ts
@Injectable()
export class OpportunitySyncSink implements ISyncSink<CanonicalOpportunity> {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    private readonly opportunities: OpportunityService,
    private readonly accounts: AccountRepository,  // FK resolution
  ) {}

  async findByExternalId(userId: string, externalId: string) {
    const row = await this.opportunities.findByExternalId(userId, externalId);
    return row ? toCanonical(row) : null;  // MUST return canonical shape
  }

  async upsertByExternalId(userId: string, record: CanonicalOpportunity, provider: string) {
    // One transaction spanning FK resolve + row upsert (+ EAV dual-write if used).
    return this.db.transaction(async (tx) => {
      const accountId = record.accountExternalId
        ? (await this.accounts.findByExternalIdRequired(userId, record.accountExternalId, tx)).id
        : null;
      const { id, saved } = await this.opportunities.upsert(
        userId, { ...record, accountId, provider }, { tx },
      );
      return { id, saved: toCanonical(saved) };
    });
  }

  async softDeleteByExternalId(userId: string, externalId: string) {
    const result = await this.opportunities.softDeleteByExternalId(userId, externalId);
    return result ? { id: result.id } : null;
  }
}
```

**Rules for sinks:**

- **`findByExternalId` MUST return canonical.** The differ compares it against
  `change.record` (also canonical). Mixing canonical and local shapes makes
  every row look "changed." Project the local row before returning.
- **`upsertByExternalId` owns the transactional envelope** — FK resolution, EAV
  dual-write (canonical columns + custom-field rows), `user_id` + `provider`
  stamping all happen inside its transaction. The subsystem never reaches around
  the sink to write local tables. **Return the local id** so the orchestrator
  can record it on `sync_run_items.local_id`.
- **Re-entry tolerance is the sink's job.** A webhook retry or polling overlap
  can deliver the same record twice — make the upsert idempotent (typically
  `ON CONFLICT (external_id) DO UPDATE` with no-op semantics when nothing
  changed).

## The `detection:` block — provider-keyed codegen factory

For poll-mode integrations you can declare detection config in the entity YAML
instead of hand-writing the adapter. Declare one `DetectionConfig` per
integration provider:

```yaml
# entities/opportunity.yaml
sync:
  providers:
    hubspot-crm:    { remote_entity: deal,        direction: inbound }
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

Codegen emits exactly one `<entity>-sync-source.module.ts` per entity,
regardless of provider count. It exports two runtime symbols (plus the module
class):

| Symbol | Type | Who fills it |
|---|---|---|
| `OPPORTUNITY_POLL_FETCH_REGISTRY` | `Record<string, PollFetchCallback<Opportunity>>` | you supply the fetch fns |
| `OPPORTUNITY_CHANGE_SOURCES` | `ReadonlyMap<string, IChangeSource<Opportunity>>` | factory output |

The factory iterates the parsed detection configs once and builds one change
source per provider — there is no per-provider symbol and no
`isMultiProvider` branch. Adding a provider to YAML changes the configs map's
contents and nothing in the generated symbol space.

Wire your fetch callbacks in a feature module:

```ts
import {
  OPPORTUNITY_POLL_FETCH_REGISTRY,
  OPPORTUNITY_CHANGE_SOURCES,
  OpportunitySyncSourceModule,
} from '@modules/opportunity-sync-source.module';
import type { OpportunityProvider } from '@modules/opportunity-sync-source.providers';
import { hubspotFetchOpportunities, salesforceFetchOpportunities } from './my-fetches';

@Module({
  imports: [OpportunitySyncSourceModule],
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
export class OpportunitySyncWiringModule {}
```

The sibling `<entity>-sync-source.providers.ts` artifact exports the
`<EntityName>Provider` literal-union type — using `Record<OpportunityProvider, …>`
(or the `satisfies` form above) turns a provider-key typo into a compile error.

Your poll fetch callback receives exactly `{ subscription, cursor, filters }`.
Run-scope identity (`userId`, `tenantId`) is NOT threaded through the port — close
it over at adapter construction, or resolve it inside the callback via your own
services.

## Triggering a run

`ExecuteSyncUseCase` does not schedule itself. Common triggers:

**Scheduled job (typical polling)** — wrap the use case in a normal background
job on one of *your own* pools (never a reserved `events_*` pool — those belong
to the event/bridge machinery and throw at boot) and give it a cron trigger
(see the `jobs` skill for the handler shape + scheduling):

```ts
@JobHandler<{ subscriptionId: string; tenantId?: string }>('sync_opportunity_poll', {
  pool: 'batch',
})
export class SyncOpportunityPollHandler extends JobHandlerBase<{
  subscriptionId: string;
  tenantId?: string;
}> {
  constructor(private readonly execute: ExecuteSyncUseCase<CanonicalOpportunity>) {
    super();
  }

  async run(ctx: JobContext<{ subscriptionId: string; tenantId?: string }>) {
    return this.execute.execute({
      subscription: { id: ctx.input.subscriptionId, domain: 'opportunity' },
      userId: 'system',
      provider: 'salesforce-crm',
      direction: 'inbound',
      action: 'poll',
      tenantId: ctx.input.tenantId ?? null,
    });
  }
}
```

**Webhook handler** — pass `action: 'webhook'` and, if the payload carries the
records, a `sourceOverride` adapter that yields them instead of the DI-bound
source:

```ts
return this.execute.execute({
  subscription: { id: sub.id, domain: 'opportunity' },
  userId: 'system', provider: 'salesforce-crm',
  direction: 'inbound', action: 'webhook', tenantId: sub.tenantId,
  sourceOverride: new SalesforceWebhookChangeSource(body.records),
});
```

**Manual operator re-sync** — `action: 'manual'` distinguishes operator runs
from scheduled ones in the audit log:

```ts
await this.execute.execute({
  subscription: { id: subscriptionId, domain: 'opportunity' },
  userId: actor.id, provider: 'salesforce-crm',
  direction: 'inbound', action: 'manual', tenantId: actor.tenantId,
});
```

## Emitting events on successful sync

The orchestrator does not emit events — wire `TypedEventBus.publish(...)`
inside your sink's `upsertByExternalId` transaction, after the row is saved, so
the event and the write commit (or roll back) together:

```ts
async upsertByExternalId(userId, record, provider) {
  return this.db.transaction(async (tx) => {
    const { id, saved } = await this.opportunities.upsert(userId, record, { tx });
    await this.events.publish('opportunity_updated', id, {
      opportunityId: id, amount: saved.amount, stageName: saved.stageName, actorUserId: userId,
    }, { tx });
    return { id, saved: toCanonical(saved) };
  });
}
```

The change-direction event lands in the `events_change` pool; downstream
consumers subscribe via their own handlers. See the `events` skill.

## Multi-tenancy

Three things change when `multi_tenant: true`:

1. **`SyncModule.forRoot({ backend: 'drizzle', multiTenant: true })`** in
   `AppModule` — binds the multi-tenant flag the orchestrator and Drizzle
   backends inject.
2. **Every `execute()` call passes `tenantId`.** Missing/null throws
   `MissingTenantIdError` at entry, *before* a `sync_runs` row is opened (no
   dangling `status=running` rows). The Drizzle backends re-validate at their
   write boundary (defense in depth); all sites share one helper so error
   messages match. Explicit `null` is allowed only for deliberate cross-tenant
   work.
3. **Schema gains `tenant_id` columns** on all three sync tables. Flip
   `sync.multi_tenant: true` in `codegen.config.yaml`, re-run
   `subsystem install sync --force --force-config` to re-emit the schema, then
   apply the migration **before** flipping the module flag — otherwise the
   Drizzle backends throw `column "tenant_id" does not exist` on every write.

Memory backends (tests) accept `tenantId` and record it but never throw —
process-local state has no meaningful cross-tenant isolation. Tests that assert
isolation guarantees must target the Drizzle backends against real Postgres.

## Loopback suppression (optional)

Only needed if your system writes *outbound* to the upstream, which then echoes
the change back on the next inbound poll. Implement and bind a fingerprint
store:

```ts
interface ILoopbackFingerprintStore<T = unknown> {
  isEchoOfOwnWrite(entityType: string, externalId: string, record: T): Promise<boolean>;
}

{ provide: SYNC_LOOPBACK_FINGERPRINT_STORE, useClass: RedisLoopbackStore }
```

Record a fingerprint (hash of the canonicalized record, TTL **shorter than the
poll interval**) on your outbound write path; `isEchoOfOwnWrite` returns true
when the next inbound change matches. The orchestrator's `@Optional()` inject
means consumers without a writeback path omit the binding — the check is
skipped. An echo is recorded as `operation='noop', status='skipped'` so you can
verify suppression in the audit log; the sink is never called.

## Testing

`SyncModule.forRoot({ backend: 'memory' })` plus memory feature-module fakes
gives an end-to-end test with no Postgres:

```ts
import { SyncModule, MemoryRunRecorder } from '@shared/subsystems/sync';

const moduleRef = await Test.createTestingModule({
  imports: [
    SyncModule.forRoot({ backend: 'memory' }),
    OpportunitySyncTestModule,  // same shape as the real feature module, with fakes
  ],
}).compile();

const orch = moduleRef.get(ExecuteSyncUseCase);
const recorder = moduleRef.get(MemoryRunRecorder);

await orch.execute({ /* ... */ });

const runs = recorder.getRunsForSubscription('sub-1');   // ergonomic test helpers
expect(runs[0].status).toBe('success');
expect(recorder.getItemsForRun(runs[0].id)).toHaveLength(3);
```

Unit-test sinks against a real test DB (or a transaction-wrapping mock);
unit-test adapters against an HTTP mock for the upstream API; integration-test
the full stack against real Postgres for end-to-end coverage.
