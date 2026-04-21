# Audit model

Three tables, one contract. This file describes the shape, the
ADR-0003 `changed_fields` decision, and the queries consumers
typically write against them.

## Tables

### `sync_subscriptions`

Cursor owner per `(integration_id, adapter, domain, external_ref)`
tuple. Addressable by id by `ICursorStore`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `defaultRandom()` |
| `integration_id` | text | Opaque id of the connected account/instance (SFDC org id, GH installation id, etc.) |
| `adapter` | text | Short adapter label: `'salesforce'`, `'hubspot'` |
| `domain` | text | Canonical entity: `'opportunity'`, `'contact'` |
| `external_ref` | text NULL | Upstream scope (filter id, webhook subscription id); NULL = full domain |
| `enabled` | bool, default true | Scheduling filter |
| `config` | jsonb, default `{}` | Per-subscription config (`batchSize`, `highWatermark`, …) |
| `cursor` | jsonb NULL | Opaque; written by `ICursorStore.put()`; NULL until first successful run |
| `last_sync_at` | ts NULL | Stamped by `PostgresCursorStore.put()` alongside cursor |
| `tenant_id` | text NULL | Scaffold-time conditional (`sync.multi_tenant: true`) |
| `created_at` / `updated_at` | ts |  |

**Indexes:**
- `uq_sync_subscriptions_tuple` — unique on `(integration_id, adapter, domain, external_ref)`. Postgres treats NULL `external_ref` as distinct (intentional — NULL = "full domain" covers only one logical slot but the DB doesn't prevent duplicates there; that's a consumer modeling concern).
- `idx_sync_subscriptions_enabled_last_sync` — the scheduling query: "list enabled subscriptions ordered by staleness."

### `sync_runs`

One row per invocation of `ExecuteSyncUseCase.execute()`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK |  |
| `subscription_id` | uuid FK → `sync_subscriptions.id` (cascade) |  |
| `direction` | enum `inbound \| outbound` | Almost always `inbound`; `outbound` reserved for writeback |
| `action` | enum `poll \| cdc \| webhook \| manual \| writeback` | Provenance for self-identification |
| `status` | enum `running \| success \| no_changes \| failed` | `running` is in-flight only |
| `records_found` / `records_processed` | int, default 0 |  |
| `cursor_before` / `cursor_after` | jsonb NULL | Opaque cursor snapshots |
| `duration_ms` | int NULL | Stamped at `completeRun` |
| `error` | text NULL | From `completeRun(input.error)` — run-level error only |
| `started_at` | ts, default now |  |
| `completed_at` | ts NULL | NULL when `status='running'` |
| `tenant_id` | text NULL | Scaffold-time conditional |

**Indexes:**
- `idx_sync_runs_subscription_started_at` — timeline: "most recent runs for this subscription"
- `idx_sync_runs_status_started_at` — stale-run sweeper: "runs that started > N minutes ago and are still running"

### `sync_run_items`

One row per upstream change the orchestrator processed within a run.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK |  |
| `sync_run_id` | uuid FK → `sync_runs.id` (cascade) |  |
| `entity_type` | text | Canonical domain (`'opportunity'`) |
| `external_id` | text | Upstream id |
| `local_id` | text NULL | Set on `operation in (created, updated, deleted)`; null on `noop` |
| `operation` | enum `created \| updated \| deleted \| noop` |  |
| `status` | enum `success \| failed \| skipped` | `skipped` = loopback echo |
| `changed_fields` | jsonb NOT NULL, default `{}` | ADR-0003 shape; validated by `FieldDiffSchema.parse` at write |
| `title` | text NULL | Optional human label (`"Pinnacle opportunity"`) |
| `error` | text NULL | Item-level error on `status='failed'` |
| `created_at` | ts, default now |  |
| `tenant_id` | text NULL | Scaffold-time conditional |

**Indexes:**
- `idx_sync_run_items_run_created_at` — timeline within a run
- `idx_sync_run_items_entity_external` — per-record history: "every sync that touched opportunity/$extId"

## ADR-0003 `changed_fields` shape

```jsonc
{
  "stage_name": { "from": "Prospecting", "to": "Closed Won" },
  "amount":     { "from": 92364,          "to": 120000 }
}
```

Enforced at write time by `FieldDiffSchema.parse` in the recorder
backend (both Drizzle and Memory). Malformed shapes throw a
`ZodError` BEFORE the INSERT fires — consumers see a validation
error, not a DB constraint error.

**Why structured, not freeform:**

Dealbrain-v2's pre-subsystem audit log stored diffs as arbitrary
payload objects. Drift-detection queries ("when did this opportunity
first become Closed Won?") required scraping JSON with
`jsonb_path_exists` + custom extraction per query. The structured
shape makes every drift query a one-shot SQL filter:

```sql
-- When did opportunity X first become Closed Won?
SELECT sri.created_at
FROM sync_run_items sri
WHERE sri.entity_type = 'opportunity'
  AND sri.external_id = '006Ab00000ABC'
  AND sri.changed_fields -> 'stage_name' ->> 'to' = 'Closed Won'
ORDER BY sri.created_at ASC
LIMIT 1;
```

Without the structure, that query is a custom function call. With it,
it's an index-friendly filter that every developer on the team can
write in two minutes.

**Canonical shapes for each `operation`:**

| Operation | `changed_fields` |
|---|---|
| `created` | `{ [field]: { from: null, to: <value> } }` for every non-null user field |
| `updated` | `{ [field]: { from: <old>, to: <new> } }` for mutated fields only |
| `deleted` | `{}` (empty — deletion itself is the change) |
| `noop` | `{}` (no change detected) |

**Created-row diffs include `external_id` and other domain fields.**
The default `DeepEqualDiffer` ignore list covers row metadata
(`id`, `createdAt`, `updatedAt`, ...) but not domain identifiers.
If that's too wide for a consumer's audit preferences, augment via
`new DeepEqualDiffer({ ignore: [...] })` in their feature module.

## Common queries

### "What changed in the last 24 hours across all sync?"

```sql
SELECT sr.action, sri.entity_type, sri.external_id, sri.operation, sri.changed_fields
FROM sync_run_items sri
JOIN sync_runs sr ON sri.sync_run_id = sr.id
WHERE sri.created_at > now() - interval '1 day'
  AND sri.status = 'success'
  AND sri.operation != 'noop'
ORDER BY sri.created_at DESC;
```

### "Which subscriptions are stale?"

```sql
SELECT id, adapter, domain, external_ref, last_sync_at
FROM sync_subscriptions
WHERE enabled = true
  AND (last_sync_at IS NULL OR last_sync_at < now() - interval '1 hour')
ORDER BY last_sync_at ASC NULLS FIRST;
```

Uses `idx_sync_subscriptions_enabled_last_sync`.

### "Any runs stuck in-flight?"

```sql
SELECT sr.id, sr.subscription_id, sr.started_at, sr.action
FROM sync_runs sr
WHERE sr.status = 'running'
  AND sr.started_at < now() - interval '10 minutes';
```

Uses `idx_sync_runs_status_started_at`. Should return zero rows under
normal operation — `completeRun` runs in a finally block. Non-zero
counts indicate the process died mid-run (SIGKILL, OOM) without
reaching the finally clause.

### "Per-record history: every sync that touched this opportunity"

```sql
SELECT sri.created_at, sri.operation, sri.status, sri.changed_fields, sr.action
FROM sync_run_items sri
JOIN sync_runs sr ON sri.sync_run_id = sr.id
WHERE sri.entity_type = 'opportunity'
  AND sri.external_id = '006Ab00000ABC'
ORDER BY sri.created_at DESC;
```

Uses `idx_sync_run_items_entity_external`.

### "Drift detection: opportunities whose `amount` changed in the last week"

```sql
SELECT sri.external_id,
       sri.changed_fields -> 'amount' ->> 'from' AS old_amount,
       sri.changed_fields -> 'amount' ->> 'to'   AS new_amount,
       sri.created_at
FROM sync_run_items sri
WHERE sri.entity_type = 'opportunity'
  AND sri.created_at > now() - interval '7 days'
  AND sri.changed_fields ? 'amount'
ORDER BY sri.created_at DESC;
```

The `?` operator hits the jsonb column directly; no JOIN, no JSONB
function gymnastics.

## Multi-tenant filter

When `multi_tenant: true`, every query above gains an `AND tenant_id
= $1` filter (or a `tenant_id = current_setting('app.tenant_id')::text`
if you've plumbed a per-request tenant context). The column is
scaffold-emitted only when the flag is on, so single-tenant
deployments don't carry the overhead.

## Ownership

All three tables are **subsystem-owned**. `PostgresCursorStore` reads
/ writes `sync_subscriptions.cursor`; `DrizzleSyncRunRecorder` reads /
writes `sync_runs` + `sync_run_items`. Consumers query them freely
(dashboards, admin UIs) but must not write to them directly —
bypassing the recorder's `FieldDiffSchema.parse` gate will land
malformed data that breaks drift-detection queries.

**Do not ship entity YAMLs for these tables.** The SYNC-7 scaffold
explicitly skips them — shipping entity YAMLs would produce
redundant repositories/services that shadow the subsystem. Phase 2's
`examples/sync/` is the correct placement for reference schemas if a
future consumer wants CRUD scaffolding over sync audit data.
