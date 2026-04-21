# Migrating from a bespoke sync pipeline to the sync subsystem

Who this is for: consumers already running custom `CrmSyncService` /
`ExecuteSync` / hand-rolled cursor-store code that predates the sync
subsystem. The obvious reference case is dealbrain-v2's CRM sync —
~800 LOC across three commits that this subsystem extracted and
generalized. The steps below describe the exact migration path that
validated the subsystem's shape.

If you're starting a new project, you don't need this guide — read
[Sync subsystem](../CONSUMER-SETUP.md#sync-subsystem) in CONSUMER-SETUP
instead.

## The decision you're making

Before any code moves: confirm the subsystem fits your detection model.
It's optimized for the five-step dance every external integration repeats:

> detect upstream change → diff against local state → apply → record
> delta → emit event

Steps 2–5 are machinery shared across integrations. Step 1 varies per
provider but has exactly three shapes — poll, CDC, webhook — which the
port's `ChangeSource` enum covers. If your pipeline fundamentally does
something else (streaming projections, hand-reconciled invariants, a
Kafka topology where downstream systems own their cursors), the
subsystem is not for you.

## Step 0 — Install the subsystem

```bash
codegen subsystem install sync
```

This lands the protocols (`IChangeSource<T>`, `ISyncSink<T>`,
`ICursorStore`, `IFieldDiffer<T>`, `ISyncRunRecorder`), the Drizzle +
Memory backends, the orchestrator, the default differ, and injects the
`sync:` block into your config. Atlas will now see the three audit
tables (`sync_subscriptions`, `sync_runs`, `sync_run_items`) as pending
diffs; generate a migration:

```bash
atlas migrate diff --env local --name add_sync_audit_tables
atlas migrate apply --env local
```

At this point the subsystem is installed but nothing is using it. Your
bespoke pipeline keeps running unchanged.

## Step 1 — Introduce `IChangeSource<T>` adapters, provider by provider

Wrap your existing upstream code as an `IChangeSource<T>` implementation.
The implementation doesn't need to change its internal logic — it just
needs to expose the yield-changes shape:

### Before

```ts
// Old: bespoke SalesforceSyncService pulling Opportunity changes.
class SalesforceSyncService {
  async runOpportunitySync() {
    const cursor = await this.cursorRepo.get('sfdc-opp');
    const records = await this.sfdc.query(...);
    for (const r of records) {
      await this.diffAndWrite(r);
      await this.cursorRepo.set('sfdc-opp', r.SystemModstamp);
    }
  }
  // ...diffAndWrite, cursor advance, audit writes all inline...
}
```

### After

```ts
// New: adapter implements IChangeSource<T>. The orchestrator owns the loop.
import type { IChangeSource, Change, SyncSubscriptionView } from '@shared/subsystems/sync';

@Injectable()
export class SalesforceOpportunityChangeSource
  implements IChangeSource<CanonicalOpportunity>
{
  readonly label = 'salesforce-poll-opportunity';

  constructor(private readonly sfdc: SalesforceClient) {}

  async *listChanges(
    sub: SyncSubscriptionView,
  ): AsyncIterable<Change<CanonicalOpportunity>> {
    const cursor = sub.cursor as { systemModstamp?: string } | null;
    const since = cursor?.systemModstamp ?? '1970-01-01T00:00:00Z';
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

The cursor shape is opaque at the port seam — your strategy types it
internally. For polling, `{ systemModstamp }`; for CDC, `{ replayId }`;
for webhook, `{ ts }`.

**Decide once per provider:** whether the adapter is one `IChangeSource`
per canonical entity (recommended — narrower scope, one label per
run-log row) or one `IChangeSource` that yields a discriminated union.
The first shape composes better with the orchestrator.

## Step 2 — Introduce `ISyncSink<T>` for each canonical entity

Your existing services (`OpportunityService`, `AccountService`) know how
to write local rows. The sink wraps them, speaking the canonical shape
externally:

```ts
@Injectable()
export class OpportunitySyncSink implements ISyncSink<CanonicalOpportunity> {
  constructor(
    private readonly svc: OpportunityService,
    private readonly fields: FieldValueService,  // for EAV dual-write
  ) {}

  async findByExternalId(userId: string, externalId: string) {
    const local = await this.svc.findByExternalId(userId, externalId);
    return local ? toCanonical(local) : null;
  }

  async upsertByExternalId(
    userId: string,
    record: CanonicalOpportunity,
    provider: string,
  ) {
    // Open a transaction spanning the row write + EAV field writes.
    // Return the local id + canonical projection of the saved row.
    return this.db.transaction(async (tx) => {
      const { id, saved } = await this.svc.upsert(userId, record, { tx });
      await this.fields.syncFromCanonical(id, record.fields ?? {}, tx);
      return { id, saved: toCanonical(saved) };
    });
  }

  async softDeleteByExternalId(userId: string, externalId: string) {
    const deleted = await this.svc.softDeleteByExternalId(userId, externalId);
    return deleted ? { id: deleted.id } : null;
  }
}
```

The sink is where all your provider-specific write policy lives (EAV
dual-write, FK resolution, provider field stamping). The subsystem does
not prescribe any of that — sinks are intentionally consumer-owned.

## Step 3 — Swap your orchestrator call for `ExecuteSyncUseCase`

Replace the bespoke sync-loop invocation with the generic orchestrator.
The feature module binds source + sink + orchestrator:

```ts
@Module({
  providers: [
    { provide: SYNC_CHANGE_SOURCE, useClass: SalesforceOpportunityChangeSource },
    { provide: SYNC_SINK,          useClass: OpportunitySyncSink },
    ExecuteSyncUseCase,
  ],
  exports: [ExecuteSyncUseCase],
})
export class OpportunitySyncModule {}
```

Then wherever your old scheduler / CLI / trigger ran the bespoke service:

```ts
// Before:
// await this.salesforceSyncService.runOpportunitySync();

// After:
const result = await this.executeSync.execute({
  subscription: { id: subscriptionId, domain: 'opportunity' },
  userId: actorId,
  provider: 'salesforce-crm',
  direction: 'inbound',
  action: 'poll',
});

if (result.status === 'failed') {
  // result.error is the cause; partial progress is in result.recordsProcessed
}
```

## Step 4 — Delete the old code

Once the new path is running in production for one full sync cycle (and
you've spot-checked the audit log against your expected changes):

- Delete the bespoke orchestrator class.
- Delete the bespoke cursor repository — the subsystem owns
  `sync_subscriptions.cursor` now.
- Delete the bespoke audit writes — `ExecuteSyncUseCase` writes
  `sync_runs` + `sync_run_items` on every run.
- Delete any one-off "re-run since timestamp" scripts — use the
  orchestrator's `action: 'manual'` mode with a temporary
  `sourceOverride` instead.

CLAUDE.md's "no backwards compatibility" principle applies: don't leave
deprecated versions, don't ship parallel paths, don't keep the old
schema tables around. Cut cleanly.

## Step 5 — Backfill historical runs (optional)

If your bespoke pipeline wrote its own audit log and you want a unified
history in `sync_runs` / `sync_run_items`, that's a one-off ETL. The
subsystem's recorder writes one row per run at the end of the loop, so
backfilling is a matter of rewriting old audit rows into the new schema.
Don't invest in this unless downstream consumers (dashboards,
drift-detection queries) actually read the old log.

## Things you will notice

- **Cursor advance is per-successful-yield, not per-successful-batch.**
  The orchestrator persists the last-yielded `change.cursor` when the
  iterator completes. A source iterator that throws mid-run still
  advances to the last-good cursor — re-running picks up from the
  furthest delivered record, not the beginning of the batch.

- **All-failed runs still advance the cursor.** If every record in a
  run failed, the subsystem marks the run `status: 'failed'` but
  persists the new cursor anyway. Rationale: the source kept yielding;
  re-running would not re-deliver those records. Retry semantics
  (dead-letter replay, manual re-sync with `action: 'manual'`) are the
  caller's concern. If this isn't what you want, wrap the orchestrator
  with your own retry policy layer.

- **Created-record diffs include every non-null user field** — including
  domain identifiers like `external_id`. The default `DeepEqualDiffer`
  ignores only row metadata (`id`, `createdAt`, `updatedAt`, ...). If
  you want to trim additional fields from the audit log, pass an
  `options.ignore` when binding the differ:
  ```ts
  { provide: SYNC_FIELD_DIFFER, useValue: new DeepEqualDiffer({ ignore: ['sync_version', 'internal_meta'] }) }
  ```

- **Loopback-fingerprint suppression is opt-in.** If your pipeline has an
  outbound writeback path that echoes back on the next inbound poll,
  bind an `ILoopbackFingerprintStore` to `SYNC_LOOPBACK_FINGERPRINT_STORE`
  in your feature module. The orchestrator's `@Optional()` inject means
  absence is fine — if you don't need it, don't provide it.

## Further reading

- [Sync subsystem](../CONSUMER-SETUP.md#sync-subsystem) — fresh-install
  guide.
- `.claude/skills/sync/SKILL.md` + L1 files — agent-facing decision
  map.
- Epic #60 — design rationale, `IChangeSource<T>` compromise analysis,
  ADR-0003 audit model shape, dealbrain-v2 extraction verdict.
