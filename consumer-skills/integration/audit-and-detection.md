<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Audit model, orchestrator flow, and diffing

The integration subsystem records every run into three tables and runs every
integration through one orchestrator loop. This file covers the table shapes,
the structured `changed_fields` contract, the queries you'll write against the
audit log, the orchestrator's run lifecycle and failure semantics, and how the
default field differ works.

## The three audit tables

All three are **subsystem-owned**. Query them freely for dashboards and admin
UIs, but never write to them directly (you'd bypass the recorder's validation),
and never author entity YAMLs for them (that produces redundant
repositories/services that shadow the subsystem).

### `integration_subscriptions`

Cursor owner per `(connection_id, adapter, domain, external_ref)` tuple. The
cursor store reads/writes it.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `defaultRandom()` |
| `connection_id` | text | Opaque id of the connected account/instance (SFDC org id, GH installation id, …) |
| `adapter` | text | Short adapter label: `'salesforce'`, `'hubspot'` |
| `domain` | text | Canonical entity: `'opportunity'`, `'contact'` |
| `external_ref` | text NULL | Upstream scope (filter id, webhook subscription id); NULL = full domain |
| `enabled` | bool, default true | Scheduling filter |
| `config` | jsonb, default `{}` | Per-subscription config (`batchSize`, `highWatermark`, …) |
| `cursor` | jsonb NULL | Opaque; written by the cursor store; NULL until first successful run |
| `last_sync_at` | ts NULL | Stamped alongside `cursor` |
| `tenant_id` | text NULL | Present only when `integration.multi_tenant: true` |
| `created_at` / `updated_at` | ts | |

Indexes: a unique `(connection_id, adapter, domain, external_ref)` tuple
(Postgres treats NULL `external_ref` as distinct — that's a consumer modeling
concern), and an `(enabled, last_sync_at)` scheduling index.

### `integration_runs`

One row per `ExecuteIntegrationUseCase.execute()` invocation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `subscription_id` | uuid FK → `integration_subscriptions.id` (cascade) | |
| `direction` | enum `inbound \| outbound` | Almost always `inbound`; `outbound` reserved for writeback |
| `action` | enum `poll \| cdc \| webhook \| manual \| writeback` | Provenance for self-identification |
| `status` | enum `running \| success \| no_changes \| failed` | `running` is in-flight only |
| `records_found` / `records_processed` | int, default 0 | |
| `cursor_before` / `cursor_after` | jsonb NULL | Opaque cursor snapshots |
| `duration_ms` | int NULL | Stamped at completion |
| `error` | text NULL | Run-level error only |
| `started_at` | ts, default now | |
| `completed_at` | ts NULL | NULL while `status='running'` |
| `tenant_id` | text NULL | Present only when multi-tenant |

Indexes: `(subscription_id, started_at)` for timelines, `(status, started_at)`
for the stale-run sweeper.

### `integration_run_items`

One row per upstream change processed within a run.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `integration_run_id` | uuid FK → `integration_runs.id` (cascade) | |
| `entity_type` | text | Canonical domain (`'opportunity'`) |
| `external_id` | text | Upstream id |
| `local_id` | text NULL | Set on `created \| updated \| deleted`; null on `noop` |
| `operation` | enum `created \| updated \| deleted \| noop` | |
| `status` | enum `success \| failed \| skipped` | `skipped` = loopback echo |
| `changed_fields` | jsonb NOT NULL, default `{}` | Structured `{ from, to }` shape; validated at write |
| `title` | text NULL | Optional human label |
| `error` | text NULL | Item-level error on `status='failed'` |
| `created_at` | ts, default now | |
| `tenant_id` | text NULL | Present only when multi-tenant |

Indexes: `(integration_run_id, created_at)` for within-run timelines,
`(entity_type, external_id)` for per-record history.

## The `changed_fields` contract

`changed_fields` is structured `{ fieldName: { from, to } }` jsonb — not
freeform:

```jsonc
{
  "stage_name": { "from": "Prospecting", "to": "Closed Won" },
  "amount":     { "from": 92364,          "to": 120000 }
}
```

It is validated against the field-diff schema at the recorder boundary in
**both** the Drizzle and Memory backends, before the INSERT. A malformed shape
throws a validation error (not a DB constraint error) so you catch it at the
recorder, not in the database.

**Why structured beats freeform:** drift queries become one-shot SQL filters
instead of JSON scrapes. "When did this opportunity first become Closed Won?" is
an index-friendly filter any developer writes in two minutes (see queries
below), not a custom JSONB-extraction function per question.

**Canonical shape per operation:**

| Operation | `changed_fields` |
|---|---|
| `created` | `{ [field]: { from: null, to: <value> } }` for every non-null user field |
| `updated` | `{ [field]: { from: <old>, to: <new> } }` for mutated fields only |
| `deleted` | `{}` — the deletion itself is the change |
| `noop` | `{}` — no change detected |

Created-row diffs include domain identifiers like `external_id` — they are
legitimately part of a new record's diff. If that's too wide for your audit
taste, augment the differ's ignore list in your feature module (see Diffing).

## Common queries

**"What changed in the last 24 hours across all integration?"**

```sql
SELECT sr.action, sri.entity_type, sri.external_id, sri.operation, sri.changed_fields
FROM integration_run_items sri
JOIN integration_runs sr ON sri.integration_run_id = sr.id
WHERE sri.created_at > now() - interval '1 day'
  AND sri.status = 'success'
  AND sri.operation != 'noop'
ORDER BY sri.created_at DESC;
```

**"Which subscriptions are stale?"** (uses the `(enabled, last_sync_at)` index)

```sql
SELECT id, adapter, domain, external_ref, last_sync_at
FROM integration_subscriptions
WHERE enabled = true
  AND (last_sync_at IS NULL OR last_sync_at < now() - interval '1 hour')
ORDER BY last_sync_at ASC NULLS FIRST;
```

**"Any runs stuck in-flight?"** (uses the `(status, started_at)` index — should
return zero rows under normal operation; non-zero means the process died
mid-run without reaching the completion path)

```sql
SELECT sr.id, sr.subscription_id, sr.started_at, sr.action
FROM integration_runs sr
WHERE sr.status = 'running'
  AND sr.started_at < now() - interval '10 minutes';
```

**"When did opportunity X first become Closed Won?"**

```sql
SELECT sri.created_at
FROM integration_run_items sri
WHERE sri.entity_type = 'opportunity'
  AND sri.external_id = '006Ab00000ABC'
  AND sri.changed_fields -> 'stage_name' ->> 'to' = 'Closed Won'
ORDER BY sri.created_at ASC
LIMIT 1;
```

**"Drift detection: opportunities whose `amount` changed in the last week"**
(the `?` operator hits the jsonb column directly — no JOIN, no JSONB function
gymnastics)

```sql
SELECT sri.external_id,
       sri.changed_fields -> 'amount' ->> 'from' AS old_amount,
       sri.changed_fields -> 'amount' ->> 'to'   AS new_amount,
       sri.created_at
FROM integration_run_items sri
WHERE sri.entity_type = 'opportunity'
  AND sri.created_at > now() - interval '7 days'
  AND sri.changed_fields ? 'amount'
ORDER BY sri.created_at DESC;
```

When `multi_tenant: true`, add `AND tenant_id = $1` to any of these.

## Orchestrator run lifecycle

```
execute(input)
  ├─ assertTenantId(input.tenantId)             ← throws BEFORE startRun when multiTenant
  ├─ cursorBefore = cursors.get(subId, tenantId)
  ├─ runId = recorder.startRun({ subId, direction, action, cursorBefore, tenantId })
  │
  ├─ for await (change of source.listChanges(sub, cursorBefore)):
  │    recordsFound++; latestCursor = change.cursor; cursorAdvanced = true
  │    try:
  │      if loopback.isEchoOfOwnWrite(…): recordItem({ operation:'noop', status:'skipped' }); continue
  │      if change.operation === 'deleted':
  │        result = sink.softDeleteByExternalId(…)
  │        recordItem({ operation: result ? 'deleted' : 'noop', status:'success', localId: result?.id })
  │      else:
  │        existing = sink.findByExternalId(…)
  │        diff = differ.diff(existing, change.record, change.providerChangedFields)
  │        if diff === 'noop': recordItem({ operation:'noop', status:'success' })
  │        else:
  │          { id } = sink.upsertByExternalId(…)
  │          recordItem({ operation: existing===null ? 'created' : 'updated',
  │                       status:'success', localId: id, changedFields: diff })
  │      recordsProcessed++
  │    catch: recordsFailed++; recordItem({ status:'failed', error })
  │
  ├─ if cursorAdvanced: cursors.put(subId, latestCursor, tenantId)
  └─ recorder.completeRun(runId, { status, counts, cursorAfter, durationMs, error })   ← finally
```

### Failure semantics worth memorizing

1. **`assertTenantId` fires before `startRun`.** Rejected multi-tenant inputs
   never open a `integration_runs` row — no dangling `status=running`. Backends
   re-validate at their write boundary (defense in depth).

2. **Cursor advances per-yield, not per-success.** `latestCursor` updates on
   every yield, persisted once at the end as whatever the iterator *last*
   produced — regardless of whether that record succeeded, failed, or was
   skipped. A source that yields 10 then throws on 11 still persists the cursor
   of record 10; re-running resumes at 11.

3. **All-failed runs still advance the cursor.** If every record throws from the
   sink, the run is `status='failed'` with `error: 'all N records failed'` — but
   the cursor still persists, because the source kept yielding and re-running
   would not re-deliver those records. **This is the most common "wait, what?"
   moment for first-time consumers — document it in your runbooks.** Retry
   semantics (dead-letter replay, `action: 'manual'` resync with a
   `sourceOverride`) are caller-owned. If you want hold-on-all-fail, wrap the
   orchestrator with your own retry layer — don't change the subsystem default.

4. **Source throws mid-iteration** → run `status='failed'`, last-good cursor
   persisted, completion runs in `finally`. Partial runs don't lose progress.
   **Source throws before any yield** (connect timeout) → cursor is not advanced;
   `cursors.put` is skipped; the run completes with `cursorAfter: cursorBefore`.

5. **`completeRun` is in a `finally` block.** The run always terminates — no
   stuck `status='running'` rows. Operator cleanup queries can rely on
   `completed_at IS NULL`.

6. **Per-item failure does not fail the run.** The try/catch is per-record. A
   run with 9 successes + 1 failure is `status='success'` with
   `recordsProcessed: 9, recordsFailed: 1`. Only when *every* seen record fails
   does the run go `failed` (decision 3).

7. **`cursors.put` failure promotes a successful run to `failed`** with
   `error: 'cursor put failed: ...'`. A successful run-log but no cursor advance
   is a worse footgun than a failed-run marker — the next run would re-process
   everything — so the orchestrator surfaces the cursor problem loudly.

### What the orchestrator does NOT do

- **Does not emit events** — wire `TypedEventBus.publish(...)` inside your
  sink's `upsertByExternalId` transaction (see the change-sources L1 file).
- **Does not schedule itself** — scheduling is a job, cron, or webhook handler
  you own.
- **Does not retry** — per-item failures are recorded and skipped; run-level
  failures bubble to the caller.
- **Does not resolve subscriptions** — `input.subscription` is passed in by the
  caller; subscription lookup / enabled-checks are your concern.

## Diffing: the default `DeepEqualDiffer`

The orchestrator calls `differ.diff(existing, incoming, change.providerChangedFields)`
once per record. `existing` comes from your sink (canonical); `incoming` is
`change.record` (canonical). The default `DeepEqualDiffer` returns either a
`{ fieldName: { from, to } }` map or the literal `'noop'`.

**Default ignore list** (row metadata that sinks/services stamp):
`id`, `createdAt`, `updatedAt`, `deletedAt`, `type`, `lastModifiedAt`,
`fields`, `providerMetadata`. (`fields` is the EAV bag — diffed by the sink's
dual-write path, not the canonical layer.) Domain fields, including identifiers
like `external_id`, are NOT ignored.

**Normalizations applied during comparison** (so equal values aren't reported
as changes), but the diff output preserves the *raw* values:

- `Date → toISOString()` — adapters deliver strings, the DB driver returns
  `Date`; normalize so they match.
- Decimal-string ↔ number — Postgres `numeric` comes back as a string through
  Drizzle while adapters deliver numbers; a numeric and a finite-parseable
  string compare equal (with an empty-string guard against silent 0-equality).

**Augment the ignore list** (`ignore` values merge with the defaults):

```ts
{ provide: INTEGRATION_FIELD_DIFFER, useValue: new DeepEqualDiffer({ ignore: ['integration_version'] }) }
```

**Un-ignore a default** (`unignore` — the inverse knob). A normally-metadata
column can be *domain data* for a given entity. The canonical case: an entity
with `softDelete: false` whose `deletedAt` carries a vendor-observed retraction
tombstone *on the canonical record* (e.g. a Slack `message_deleted` maps to
`deletedAt`). Because `deletedAt` is in the default ignore list, the tombstone
overlay diffs to `'noop'`, the upsert is skipped, and `deleted_at` never lands.
`unignore` removes it from the ignore set so it registers as a field change:

```ts
{ provide: INTEGRATION_FIELD_DIFFER, useValue: new DeepEqualDiffer({ unignore: ['deletedAt'] }) }
```

`unignore` is subtracted after `ignore` is merged, so it wins on a field listed
in both. Un-ignoring a field that isn't in the (merged) set is a harmless no-op.

**Set it once for the whole app via config** instead of binding per feature
module — `integration.differ.{ignore,unignore}` in `codegen.config.yaml` threads
into the default differ that `IntegrationModule.forRoot` provides:

```yaml
integration:
  backend: drizzle
  differ:
    unignore: [deletedAt]   # this entity's deletedAt is domain data
```

Bind a per-module differ as `useValue: new DeepEqualDiffer(...)`, not `useClass`
— the constructor's optional options object confuses Nest's metadata reflection.

**`providerChangedFields` is advisory.** When a CDC provider tells you which
columns changed, set it on the `Change<T>` and the differ skips deep-equal over
untouched fields — but it still applies the ignore list. To write a fully
custom differ (type-aware enum normalization, hint-only inspection), implement
`IFieldDiffer<T>` and bind it to `INTEGRATION_FIELD_DIFFER`.
