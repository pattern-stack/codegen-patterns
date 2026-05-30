# Protocols and ports

The integration subsystem has five ports. Four of them are required for a
working run; one is optional. This file describes each port, what
authoring a custom implementation looks like, and where the design
decisions were made.

## `IChangeSource<T>` — the detection seam

The one port every integration adapter implements. Three detection modes
(poll / CDC / webhook) converge here; per-mode differences live in
`Change<T>` metadata.

```ts
interface IChangeSource<T> {
  readonly label: string;  // e.g. 'salesforce-poll-opportunity'
  listChanges(
    subscription: IntegrationSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>>;
}

interface Change<T> {
  externalId: string;
  operation: 'created' | 'updated' | 'deleted';
  record: T;                           // canonical shape — provider mapping happens in the adapter
  cursor: unknown;                     // typed internally; opaque at the seam
  source: 'poll' | 'cdc' | 'webhook';  // provenance for run-log audit
  dedupKey?: string;                   // CDC replay_id / webhook event_id when available
  providerChangedFields?: string[];    // CDC-only hint; skips deep-equal when set
}
```

**One adapter per `(provider, detection-mode, canonical-entity)` tuple.**
`SalesforcePollOpportunityChangeSource` is one class, 50-ish LOC over a
shared `PollingStrategyBase` helper. Don't write a monolithic adapter
that yields a discriminated union across entities — narrower scope
means one `label` per run-log row and better isolation.

**Cursor shape is opaque at the port.** The strategy types it
internally:
- Poll: `{ systemModstamp: string }` or `{ lastSyncedAt: string }`
- CDC: `{ replayId: number }`
- Webhook: `{ ts: number }` or `{ eventId: string }`

The orchestrator persists `change.cursor` as the iterator advances; it
does not interpret the shape.

**`providerChangedFields` is advisory.** When set (CDC providers that
tell you which columns changed), the differ can skip deep-equal over
untouched fields. Still filters through the ignore list — provider
hints don't override the ignore rules.

**Do not add mode-specific methods to `IChangeSource`.** The narrow
port is deliberate; the compromise analysis behind it is in epic #60.
If a new detection mode emerges, add a value to the `ChangeSource`
union and a metadata field if needed — not a new port.

## `IIntegrationSink<T>` — the write surface

One sink per canonical entity. Speaks canonical externally; internal
mapping stays inside.

```ts
interface IIntegrationSink<TCanonical> {
  findByExternalId(userId: string, externalId: string): Promise<TCanonical | null>;
  upsertByExternalId(userId: string, record: TCanonical, provider: string): Promise<{ id: string; saved: TCanonical }>;
  softDeleteByExternalId(userId: string, externalId: string): Promise<{ id: string } | null>;
}
```

**`findByExternalId` must return a canonical-shaped view of local state.**
The differ compares `existing` (from the sink) against
`change.record` (from the adapter) — mixing canonical and local shapes
makes every row look "changed." If the local row uses a different
column name or shape, project it inside the sink.

**`upsertByExternalId` owns the transactional envelope.** Canonical
columns, FK resolution (`account_id` from `accountExternalId`), EAV
dual-write (when the entity has `fields`), `user_id` + `provider`
stamping — all happen inside the sink's transaction. The subsystem
never reaches around the sink to write to local tables.

**Return the local id from `upsert`.** The orchestrator records it on
`integration_run_items.local_id` for later drill-down joins between the audit
log and the actual local row.

**Re-entry tolerance is the sink's job.** If the orchestrator sees the
same record twice in a window (a webhook retry, a polling overlap),
the sink's upsert must be idempotent — typically `ON CONFLICT
(external_id) DO UPDATE` with no-op semantics when the incoming record
equals the existing row.

## `ICursorStore` — cursor persistence

Subscription-addressed cursor storage.

```ts
interface ICursorStore {
  get(subscriptionId: string, tenantId?: string | null): Promise<unknown | null>;
  put(subscriptionId: string, cursor: unknown, tenantId?: string | null): Promise<void>;
}
```

**`put()` stamps `last_integration_at` + `updated_at` along with `cursor`** in
the Drizzle backend. The `(enabled, last_integration_at)` scheduling index
from SYNC-1 would be useless otherwise. If a dry-run / time-travel
use case ever emerges, the right move is a third argument, not
wrapping the port.

**`tenantId` is a signature arg, not a proxy layer.** SYNC-4 chose the
signature approach explicitly: multi-tenancy bugs are silent and
dangerous; explicit signatures catch omissions at the type boundary;
proxies hide who's enforcing. Matches JOB-8 / EVT-6 precedent. Memory
backend accepts + ignores; Drizzle enforces via `assertTenantId`.

**Do not instantiate `ICursorStore` inside a sink or adapter.** Always
inject via `INTEGRATION_CURSOR_STORE`. The orchestrator owns the `get/put`
lifecycle — call sites outside it invert the control flow.

## `IFieldDiffer<T>` — the diff seam

Pluggable differ; default ships as `DeepEqualDiffer<T>`.

```ts
interface IFieldDiffer<T> {
  diff(existing: T | null, incoming: T, providerChangedFields?: string[]): DiffResult;
}

type DiffResult = FieldDiff | 'noop';
type FieldDiff = { [fieldName: string]: { from: unknown; to: unknown } };
```

**Default `DeepEqualDiffer` ignore list** (row metadata sinks /
services stamp):
`id`, `createdAt`, `updatedAt`, `deletedAt`, `type`, `lastModifiedAt`,
`fields`, `providerMetadata`. `fields` is the EAV bag — it's diffed by
the sink's EAV dual-write path, not at the canonical-record layer.

**Normalizations applied during comparison (NOT in diff output):**

- `Date → toISOString()` — adapters deliver strings, sinks return
  `Date` from the DB driver. Normalize for comparison so they match.
- Decimal-string ↔ number — Postgres `numeric` returns as a string
  through Drizzle; adapters deliver numbers. When one side is numeric
  and the other is a finite-parseable string, they compare equal.
  Empty-string guard prevents silent 0-equality.

**Diff output preserves raw values.** When a field genuinely differs,
`{ from: Date, to: Date }` holds the raw Dates (not normalized ISO
strings). `JSON.stringify` round-trips through jsonb normalize on
persist; the audit stays faithful to the input.

**Augmenting the ignore list per entity:**

```ts
{ provide: INTEGRATION_FIELD_DIFFER, useValue: new DeepEqualDiffer({ ignore: ['integration_version'] }) }
```

Values are merged with the default set; you can't remove defaults.

**Writing a custom `IFieldDiffer<T>`** (e.g. a type-aware differ that
normalizes enums, or a CDC differ that only inspects hinted fields):
bind it to `INTEGRATION_FIELD_DIFFER` in the feature module. The orchestrator
calls `differ.diff(existing, incoming, change.providerChangedFields)`
once per record.

## `IIntegrationRunRecorder` — the audit write surface

```ts
interface IIntegrationRunRecorder {
  startRun(input: StartRunInput): Promise<{ id: string }>;
  recordItem(input: RecordItemInput): Promise<void>;
  completeRun(runId: string, input: CompleteRunInput): Promise<void>;
}
```

**`recordItem` validates `changedFields` via `FieldDiffSchema.parse`
BEFORE the write.** Both Drizzle and Memory backends do this. A
malformed shape throws a `ZodError` at the recorder boundary; the
orchestrator sees the validation failure, not a DB constraint error.

**`completeRun` does not re-check tenancy.** The run id was returned by
`startRun` which already enforced it; run ids are uuids not guessable
cross-tenant. Matches JOB-3's pattern. Do not add a tenancy guard in
`completeRun` without an ADR.

**Not shipping a per-entity recorder.** Dealbrain's bespoke recorder
had CRM-specific convenience methods (label resolution, entity-type
narrowing). The subsystem extracted the generic write path only; those
conveniences stay consumer-owned in a service layer above the recorder.

## `ILoopbackFingerprintStore<T>` — optional

Suppresses echoes of the local system's own outbound writes from the
next inbound poll/CDC/webhook.

```ts
interface ILoopbackFingerprintStore<T = unknown> {
  isEchoOfOwnWrite(entityType: string, externalId: string, record: T): Promise<boolean>;
}
```

**Not shipped by the subsystem in Phase 1.** Consumers with outbound
writeback paths provide their own (Redis-hashed with TTL shorter than
the poll interval, or in-memory for tests). `@Optional()` on the
orchestrator's inject means absence is fine — the check is skipped and
all changes are processed normally.

**`entityType` is `string` — no CRM narrowing.** Dealbrain's original
port leaked `'opportunity' | 'account' | 'contact'` into the seam;
HS-9 findings forced the fix before upstreaming. Don't re-introduce
the narrowing; consumers narrow internally if they want.
