# Consumer patterns

How a consumer wires the integration subsystem end-to-end: the feature-module
pattern, worked examples for adapters and sinks, multi-tenancy
plumbing, and the "where does the event come from?" integration
question.

## Feature module shape

`IntegrationModule.forRoot(...)` in `AppModule` wires the substrate. Every
canonical entity that integrations gets its own feature module that binds:

- `INTEGRATION_CHANGE_SOURCE` — one adapter per `(provider, detection-mode, entity)`
- `INTEGRATION_SINK` — one sink per canonical entity
- `ExecuteIntegrationUseCase` — the orchestrator class itself (NOT provided by `IntegrationModule`)
- optionally, `INTEGRATION_LOOPBACK_FINGERPRINT_STORE` and/or a custom `INTEGRATION_FIELD_DIFFER`

```ts
import { Module } from '@nestjs/common';
import {
  ExecuteIntegrationUseCase,
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_SINK,
  INTEGRATION_FIELD_DIFFER,
  DeepEqualDiffer,
} from '@shared/subsystems/integration';

@Module({
  providers: [
    { provide: INTEGRATION_CHANGE_SOURCE, useClass: SalesforceOpportunityChangeSource },
    { provide: INTEGRATION_SINK,          useClass: OpportunityIntegrationSink },
    // Override the differ per-entity when you need a different ignore list:
    {
      provide: INTEGRATION_FIELD_DIFFER,
      useValue: new DeepEqualDiffer({ ignore: ['integration_version', 'internal_notes'] }),
    },
    ExecuteIntegrationUseCase,
  ],
  exports: [ExecuteIntegrationUseCase],
})
export class OpportunityIntegrationModule {}
```

**Why `ExecuteIntegrationUseCase` is listed here and not in `IntegrationModule`:**
the orchestrator depends on `INTEGRATION_CHANGE_SOURCE + INTEGRATION_SINK`, which
are per-feature. Nest's DI resolves providers at module compile time;
putting the orchestrator in `IntegrationModule` would require those tokens
globally, which fails until the feature module is imported. The
`IntegrationModule` header documents this with a worked example.

## Writing an `IChangeSource<T>`

```ts
import { Injectable } from '@nestjs/common';
import type { IChangeSource, Change, IntegrationSubscriptionView } from '@shared/subsystems/integration';

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
    sub: IntegrationSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpportunity>> {
    const typed = cursor as { systemModstamp?: string } | null;
    const since = typed?.systemModstamp ?? '1970-01-01T00:00:00Z';

    // Session refresh happens before the query — withAuthRetry wraps
    // the SFDC client to force a refresh on 401 and retry once.
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

**Three rules:**

1. **Yield `operation: 'updated'` for existing-row changes; the
   orchestrator computes `'created'` vs `'updated'` based on whether
   `sink.findByExternalId` returns null.** Don't try to pre-compute
   this in the adapter — the adapter doesn't have a cheap way to
   check local state, and duplicating the check wastes DB round-trips.

2. **The cursor must be strictly-increasing per yield.** If you yield
   records out of cursor order, a source crash mid-run will persist
   the cursor of the last-yielded (not the last-successful) record,
   and the next run will skip the records between the crash point and
   the last yield. Order by your cursor column ASC.

3. **Auth refresh belongs here, not in the orchestrator.** The
   orchestrator has no notion of session expiry. Wrap your upstream
   client calls with a retry-on-auth-fail layer (the events-codegen /
   auth subsystem's `withAuthRetry` helper is the canonical pattern).

## Writing an `IIntegrationSink<T>`

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { IIntegrationSink } from '@shared/subsystems/integration';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';

@Injectable()
export class OpportunityIntegrationSink implements IIntegrationSink<CanonicalOpportunity> {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    private readonly opportunities: OpportunityService,
    private readonly fields: FieldValueService,  // for EAV dual-write
    private readonly accounts: AccountRepository, // for FK resolution
  ) {}

  async findByExternalId(
    userId: string,
    externalId: string,
  ): Promise<CanonicalOpportunity | null> {
    const row = await this.opportunities.findByExternalId(userId, externalId);
    if (!row) return null;
    const eavBag = await this.fields.loadForEntity('opportunity', row.id);
    return toCanonical(row, eavBag);
  }

  async upsertByExternalId(
    userId: string,
    record: CanonicalOpportunity,
    provider: string,
  ): Promise<{ id: string; saved: CanonicalOpportunity }> {
    // Single transaction spanning FK resolve + row upsert + EAV dual-write.
    return this.db.transaction(async (tx) => {
      const accountId = record.accountExternalId
        ? await this.accounts.findByExternalIdRequired(
            userId,
            record.accountExternalId,
            tx,
          ).then((a) => a.id)
        : null;

      const { id, saved } = await this.opportunities.upsert(
        userId,
        { ...record, accountId, provider },
        { tx },
      );

      await this.fields.integrationFromCanonical(
        'opportunity',
        id,
        record.fields ?? {},
        tx,
      );

      return { id, saved: toCanonical(saved, record.fields ?? {}) };
    });
  }

  async softDeleteByExternalId(
    userId: string,
    externalId: string,
  ): Promise<{ id: string } | null> {
    const result = await this.opportunities.softDeleteByExternalId(
      userId,
      externalId,
    );
    return result ? { id: result.id } : null;
  }
}
```

**The sink is where provider-specific write policy lives:**

- EAV dual-write (canonical columns + `field_values` rows for custom
  fields) — a single transaction spanning both.
- FK resolution — `accountExternalId` → local `account.id` via a
  repository lookup.
- `provider` stamping on the saved row so downstream consumers can
  filter "show me all opportunities integrated from Salesforce vs.
  HubSpot."
- Re-entry tolerance — `upsert` with `ON CONFLICT (external_id) DO
  UPDATE ... WHERE <something changed>` so a webhook retry or polling
  overlap doesn't bump `updated_at` unnecessarily.

**`findByExternalId` must return canonical.** If the local row is
shaped differently, project it before returning. Mixed shapes break
the differ.

## Triggering a run

`ExecuteIntegrationUseCase` does not schedule itself. Common triggers:

### Scheduled job (typical polling)

```ts
@JobHandler({ type: 'integration_opportunity_poll', pool: 'events_inbound' })
export class IntegrationOpportunityPollHandler {
  constructor(private readonly execute: ExecuteIntegrationUseCase<CanonicalOpportunity>) {}

  async handle(input: { subscriptionId: string; tenantId?: string }) {
    return this.execute.execute({
      subscription: { id: input.subscriptionId, domain: 'opportunity' },
      userId: 'system',
      provider: 'salesforce-crm',
      direction: 'inbound',
      action: 'poll',
      tenantId: input.tenantId ?? null,
    });
  }
}
```

Schedule the job with a cron trigger (see jobs SKILL.md §scheduling).

### Webhook handler

```ts
@Controller('webhooks/salesforce')
export class SalesforceWebhookController {
  constructor(private readonly execute: ExecuteIntegrationUseCase<CanonicalOpportunity>) {}

  @Post('opportunity-changed')
  async handle(@Body() body: SalesforceWebhookPayload) {
    const sub = await this.subscriptions.findByFingerprint(body.orgId, 'opportunity');
    return this.execute.execute({
      subscription: { id: sub.id, domain: 'opportunity' },
      userId: 'system',
      provider: 'salesforce-crm',
      direction: 'inbound',
      action: 'webhook',
      tenantId: sub.tenantId,
      // sourceOverride: replace the DI-bound source with a webhook
      // adapter that yields the records in the payload body.
      sourceOverride: new SalesforceWebhookChangeSource(body.records),
    });
  }
}
```

### Manual operator re-integration

```ts
// CLI / admin UI — `action: 'manual'` distinguishes operator-triggered
// runs from scheduled ones in the audit log.
await this.execute.execute({
  subscription: { id: subscriptionId, domain: 'opportunity' },
  userId: actor.id,
  provider: 'salesforce-crm',
  direction: 'inbound',
  action: 'manual',
  tenantId: actor.tenantId,
});
```

## Emitting events on successful integration

The orchestrator does not emit events — that's a consumer concern.
Wire `TypedEventBus.publish(...)` inside your sink's `upsertByExternalId`
transaction, after the row is saved:

```ts
async upsertByExternalId(userId, record, provider) {
  return this.db.transaction(async (tx) => {
    const { id, saved } = await this.opportunities.upsert(userId, record, { tx });

    // Emit the change event in the same transaction as the write.
    // If the transaction rolls back, the event is never persisted.
    await this.events.publish('opportunity_updated', id, {
      opportunityId: id,
      amount: saved.amount,
      stageName: saved.stageName,
      actorUserId: userId,
    }, { tx });

    return { id, saved: toCanonical(saved) };
  });
}
```

The `change` direction event lands in `events_change` pool; downstream
consumers (projections, side-effects, webhook forwarders) subscribe
via their own handlers. See events SKILL.md §directions-and-pools.

## Multi-tenancy in practice

Three changes when `multiTenant: true`:

1. **`IntegrationModule.forRoot({ backend: 'drizzle', multiTenant: true })`**
   in `AppModule`. This binds `INTEGRATION_MULTI_TENANT=true` which both
   Drizzle backends + the orchestrator inject.

2. **Every `execute()` call passes `tenantId`.** Missing / null
   throws `MissingTenantIdError` at entry (defense in depth — backends
   re-validate at write boundary). Extract from your tenant context:
   ```ts
   await this.execute.execute({ ..., tenantId: ctx.tenant.id });
   ```

3. **Schema has `tenant_id` columns on all three integration tables.** Atlas
   diff picks this up automatically when you flip
   `integration.multi_tenant: true` in `codegen.config.yaml` and re-run
   `subsystem install integration --force --force-config`. Apply the
   migration before flipping the module flag, or the Drizzle backends
   will throw `column "tenant_id" does not exist` on every write.

Memory backends (for tests) accept `tenantId` and record it on rows
but don't throw. Tests asserting cross-tenant isolation target the
Drizzle backends via real Postgres (`just test-family` /
`just test-integration`).

## Loopback suppression

Optional; only needed if your system has an outbound writeback path
(we write to Salesforce, which echoes the change back on next poll).

```ts
@Injectable()
export class RedisLoopbackStore implements ILoopbackFingerprintStore<CanonicalOpportunity> {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  async isEchoOfOwnWrite(entityType, externalId, record) {
    const key = `loopback:${entityType}:${externalId}`;
    const fingerprint = hash(canonicalize(record));
    const stored = await this.redis.get(key);
    return stored === fingerprint;
  }

  /** Call this from your writeback path BEFORE the upstream write. */
  async recordOwnWrite(entityType, externalId, record, ttlSec = 60) {
    const key = `loopback:${entityType}:${externalId}`;
    await this.redis.setex(key, ttlSec, hash(canonicalize(record)));
  }
}
```

Bind it in the feature module:

```ts
{ provide: INTEGRATION_LOOPBACK_FINGERPRINT_STORE, useClass: RedisLoopbackStore }
```

The orchestrator's `@Optional()` inject means consumers without a
writeback path simply omit the binding — the check is skipped.

TTL shorter than the poll interval — otherwise old fingerprints
pile up and silently suppress legitimate upstream edits.

## Testing

`IntegrationModule.forRoot({ backend: 'memory' })` + memory feature-module
fakes = end-to-end test with no Postgres:

```ts
import { Test } from '@nestjs/testing';
import { IntegrationModule, MemoryRunRecorder } from '@shared/subsystems/integration';

const moduleRef = await Test.createTestingModule({
  imports: [
    IntegrationModule.forRoot({ backend: 'memory' }),
    OpportunityIntegrationTestModule,  // same shape as OpportunityIntegrationModule but with fakes
  ],
}).compile();

const orch = moduleRef.get(ExecuteIntegrationUseCase);
const recorder = moduleRef.get(MemoryRunRecorder);

await orch.execute({ /* ... */ });

// Ergonomic helpers on MemoryRunRecorder make assertions one-liners.
const runs = recorder.getRunsForSubscription('sub-1');
expect(runs[0].status).toBe('success');
expect(recorder.getItemsForRun(runs[0].id)).toHaveLength(3);
```

Unit-test sinks directly against a real test database (or a
transaction-wrapping mock). Unit-test adapters against an HTTP mock
for the upstream API. Integration-test the full stack via
`just test-family` when you need Postgres end-to-end.
