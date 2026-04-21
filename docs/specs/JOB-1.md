# JOB-1 — Drizzle Schemas for `job`, `job_run`, `job_step`

**Issue:** JOB-1
**Status:** Draft
**Last Updated:** 2026-04-19
**Phase:** ADR-022 Phase 1
**Depends on:** Nothing — this is the foundation all other JOB issues build on.

## Overview

This PR adds `runtime/subsystems/jobs/job-orchestration.schema.ts`, declaring three Drizzle `pgTable` objects (`jobs`, `jobRuns`, `jobSteps`) plus their enums, indexes, and `InferSelectModel` type exports. It is a pure schema file — no service logic, no NestJS providers. All subsequent Phase 1 issues depend on the row types exported here.

## Context

**What exists.** `runtime/subsystems/jobs/` contains the legacy `IJobQueue` executor protocol and four backends (Drizzle/BullMQ/Redis/Memory) along with `job-queue.schema.ts` defining the pg-boss-style `job_queue` table. Per the architectural collapse decision (CLAUDE.md operating principles, ADR-022 revised spine), this entire executor layer is being removed — it was a degenerate transport that hid every native feature of any swappable backend behind a four-method dispatch port.

**What this PR adds.** A single new schema file `job-orchestration.schema.ts` containing the three core tables: `job`, `job_run`, `job_step`. Phase 1 ships only this single layer. There is no `job_queue` table, no executor port. Worker claim runs `SELECT ... FOR UPDATE SKIP LOCKED` directly against `job_run` (see JOB-3).

**What this PR removes.** `runtime/subsystems/jobs/job-queue.schema.ts`, `job-queue.protocol.ts`, all four `job-queue.*-backend.ts` files, `jobs.module.ts`, `jobs.tokens.ts`. The `index.ts` barrel is rewritten to export only the new orchestration schema.

## Architecture

```
job-orchestration.schema.ts
  ├── pgEnum jobRunStatus   ('pending'|'running'|'waiting'|'completed'|'failed'|'timed_out'|'canceled')
  ├── pgEnum jobStepKind    ('task')                       ← extended in ADR-027
  ├── pgEnum jobStepStatus  ('pending'|'running'|'completed'|'failed'|'skipped')
  ├── pgEnum collisionMode  ('queue'|'reject'|'replace')
  ├── pgEnum replayFrom     ('scratch'|'last_step'|'last_checkpoint')
  ├── pgEnum parentClosePolicy  ('terminate'|'cancel'|'abandon')
  ├── pgEnum waitKind       (placeholder — single value 'signal' for Phase 3)
  ├── pgTable 'job'
  ├── pgTable 'job_run'      ──FK──▶ job.type
  │                          ──FK──▶ job_run.id  (self, parent)
  └── pgTable 'job_step'     ──FK──▶ job_run.id
```

No service code touches this file. JOB-2 imports the `InferSelectModel` row types to build protocol signatures. JOB-3 imports the table objects to write queries.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/jobs/job-orchestration.schema.ts` | create | All three table declarations, enums, exported row types |
| `runtime/subsystems/jobs/index.ts` | rewrite | Export new orchestration schema symbols only; remove all `IJobQueue` exports |
| `runtime/subsystems/jobs/job-queue.schema.ts` | **delete** | Executor-layer table removed |
| `runtime/subsystems/jobs/job-queue.protocol.ts` | **delete** | Executor-layer port removed |
| `runtime/subsystems/jobs/job-queue.drizzle-backend.ts` | **delete** | Executor-layer backend removed |
| `runtime/subsystems/jobs/job-queue.bullmq-backend.ts` | **delete** | Executor-layer backend removed (BullMQ adapter to be re-introduced at orchestrator layer in Phase 6+) |
| `runtime/subsystems/jobs/job-queue.redis-backend.ts` | **delete** | Executor-layer backend removed |
| `runtime/subsystems/jobs/job-queue.memory-backend.ts` | **delete** | Executor-layer backend removed |
| `runtime/subsystems/jobs/jobs.module.ts` | **delete** | Executor-layer module removed; replaced by `JobsDomainModule` in JOB-5 |
| `runtime/subsystems/jobs/jobs.tokens.ts` | **delete** | Executor-layer tokens removed; orchestration tokens live in `jobs-domain.tokens.ts` (JOB-2) |
| `src/__tests__/runtime/subsystems/job-orchestration.schema.spec.ts` | create | Import smoke test + column-presence assertions |
| `runtime/subsystems/index.ts` | edit | Drop legacy `JOB_QUEUE` / `IJobQueue` / `JobsModule` re-exports; re-export the new orchestration surface |

## Interfaces and Column Definitions

The file follows the pattern in `job-queue.schema.ts` (Drizzle imports at top, `pgTable` call, `InferSelectModel` type alias at bottom). It extends that pattern with `pgEnum` for multi-value columns and `index` / `uniqueIndex` for the required index declarations.

### Enums

All declared via `pgEnum(name, [...values])` and exported so JOB-2 protocols can reference value-literal types.

- `jobRunStatusEnum` — name `'job_run_status'`, values `['pending', 'running', 'waiting', 'completed', 'failed', 'timed_out', 'canceled']`
- `jobStepKindEnum` — name `'job_step_kind'`, values `['task']` — comment: `// extended in ADR-027: tool_call | llm_call | wait | checkpoint | message`
- `jobStepStatusEnum` — name `'job_step_status'`, values `['pending', 'running', 'completed', 'failed', 'skipped']`
- `collisionModeEnum` — name `'job_collision_mode'`, values `['queue', 'reject', 'replace']`
- `replayFromEnum` — name `'job_replay_from'`, values `['scratch', 'last_step', 'last_checkpoint']`
- `parentClosePolicyEnum` — name `'job_parent_close_policy'`, values `['terminate', 'cancel', 'abandon']`
- `waitKindEnum` — name `'job_wait_kind'`, values `['signal']` — comment: `// Phase 3 placeholder — see ADR-025`
- `triggerSourceEnum` — name `'job_trigger_source'`, values `['manual', 'schedule', 'event', 'parent']` — comment: `// Phase 2 may add more sources; requires Atlas migration`

### `pgTable 'job'`

Primary key: `type` as `text('type').primaryKey()` — not a UUID; the business key is the handler type string (e.g. `'onboarding'`).

Columns:
- `type`: `text`, PK
- `version`: `integer`, `notNull`, default `1`
- `pool`: `text`, `notNull` — references configured pool name (string, no FK — pool names are config-time, not DB-time)
- `scopeEntityType`: `text('scope_entity_type')`, nullable — global jobs omit this
- `retryPolicy`: `jsonb('retry_policy').notNull().$type<RetryPolicy>()` — shape: `{ attempts: number, backoff: 'fixed'|'exponential', baseMs: number, nonRetryableErrors?: string[] }`
- `timeoutMs`: `integer('timeout_ms')`, nullable
- `concurrencyKeyTemplate`: `text('concurrency_key_template')`, nullable
- `collisionMode`: `collisionModeEnum('collision_mode').notNull().default('queue')`
- `dedupeKeyTemplate`: `text('dedupe_key_template')`, nullable
- `dedupeWindowMs`: `integer('dedupe_window_ms')`, nullable
- `priorityDefault`: `integer('priority_default').notNull().default(0)`
- `replayFrom`: `replayFromEnum('replay_from').notNull().default('last_checkpoint')`
- `createdAt`: `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`
- `updatedAt`: `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()`

No table-level indexes — `type` PK is sufficient; range queries on `job` are not in scope.

Exported type: `export type JobDefinitionRow = InferSelectModel<typeof jobs>`
(Name avoids collision with the common `Job` name in application code.)

### `pgTable 'job_run'`

Primary key: `uuid('id').primaryKey().defaultRandom()`

Columns:
- `id`: uuid PK
- `jobType`: `text('job_type').notNull().references(() => jobs.type)`
- `jobVersion`: `integer('job_version').notNull()`
- `parentRunId`: `uuid('parent_run_id').references(() => jobRuns.id)`, nullable (self-reference)
- `rootRunId`: `uuid('root_run_id').notNull()` — no FK; service generates `id` client-side via `randomUUID()` and sets `root_run_id = id` for root runs (single INSERT, no nullable, no self-FK race)
- `parentClosePolicy`: `parentClosePolicyEnum('parent_close_policy').notNull().default('terminate')`
- `scopeEntityType`: `text('scope_entity_type')`, nullable
- `scopeEntityId`: `text('scope_entity_id')`, nullable
- `tenantId`: `text('tenant_id')`, nullable. In the **runtime source file** (`runtime/subsystems/jobs/job-orchestration.schema.ts`) this column is emitted unconditionally — the runtime file is the multi-tenant variant. The scaffold-time conditional lives in the Hygen template (JOB-6), which elides this column when `codegen.config.yaml: jobs.multi_tenant` is absent/false. Inline comment on the runtime column: `// scaffold-time conditional in template — see JOB-8`. (Resolved during JOB-1 build, 2026-04-19: earlier draft suggested conditional emission in the runtime file itself, but the runtime file is never consumed directly by tenants' apps — only via the scaffold — so the conditional belongs exclusively in the template.)
- `tags`: `jsonb('tags').notNull().default({}).$type<Record<string, string>>()`
- `pool`: `text('pool').notNull()`
- `priority`: `integer('priority').notNull().default(0)`
- `concurrencyKey`: `text('concurrency_key')`, nullable
- `dedupeKey`: `text('dedupe_key')`, nullable
- `status`: `jobRunStatusEnum('status').notNull().default('pending')`
- `input`: `jsonb('input').notNull().$type<Record<string, unknown>>()`
- `output`: `jsonb('output').$type<Record<string, unknown>>()`, nullable
- `error`: `jsonb('error').$type<JobRunError>()`, nullable — shape: `{ message: string, stack?: string, retryable: boolean, attempt: number }`
- `triggerSource`: `triggerSourceEnum('trigger_source').notNull()`
- `triggerRef`: `text('trigger_ref')`, nullable
- `runAt`: `timestamp('run_at', { withTimezone: true }).notNull().defaultNow()`
- `startedAt`: `timestamp('started_at', { withTimezone: true })`, nullable
- `finishedAt`: `timestamp('finished_at', { withTimezone: true })`, nullable
- `claimedAt`: `timestamp('claimed_at', { withTimezone: true })`, nullable
- `attempts`: `integer('attempts').notNull().default(0)`
- `waitKind`: `waitKindEnum('wait_kind')`, nullable — comment: `// Phase 3 placeholder — see ADR-025`
- `resumeToken`: `text('resume_token')`, nullable — comment: `// Phase 3 placeholder — see ADR-025`
- `waitDeadline`: `timestamp('wait_deadline', { withTimezone: true })`, nullable — comment: `// Phase 3 placeholder — see ADR-025`
- `createdAt`: `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`
- `updatedAt`: `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()`

**Indexes** (declared in the table's second argument object, using Drizzle `index()` / `uniqueIndex()`):

| Index name | Columns / filter | Purpose |
|---|---|---|
| `idx_job_run_claim` | `(status, pool, run_at)` | Claim query ORDER BY priority DESC, run_at ASC |
| `idx_job_run_root` | `(root_run_id)` | Tree traversal / cascade cancel |
| `idx_job_run_scope` | `(scope_entity_type, scope_entity_id)` | listForScope query |
| `idx_job_run_dedupe` | `(job_type, dedupe_key)` partial `WHERE dedupe_key IS NOT NULL` | Idempotency collapse |
| `idx_job_run_concurrency` | `(concurrency_key)` partial `WHERE concurrency_key IS NOT NULL AND status IN ('pending','running')` | Collision check |

Drizzle partial index syntax: `.where(sql\`...\`)` passed to the `index()` builder.

Exported type: `export type JobRunRow = InferSelectModel<typeof jobRuns>`

### `pgTable 'job_step'`

Primary key: `uuid('id').primaryKey().defaultRandom()`

Columns:
- `id`: uuid PK
- `jobRunId`: `uuid('job_run_id').notNull().references(() => jobRuns.id)`
- `stepId`: `text('step_id').notNull()` — user-chosen stable identifier
- `kind`: `jobStepKindEnum('kind').notNull().default('task')`
- `seq`: `integer('seq').notNull()` — monotonic within run; `integer` (max 2B per run) is sufficient (downgraded from ADR-022's bigint; revisit only if a single run exceeds 2 billion steps, which is implausible)
- `status`: `jobStepStatusEnum('status').notNull().default('pending')`
- `input`: `jsonb('input').$type<Record<string, unknown>>()`, nullable
- `output`: `jsonb('output').$type<Record<string, unknown>>()`, nullable — memoized on success
- `error`: `jsonb('error').$type<JobRunError>()`, nullable — reuse same shape as `job_run.error`
- `attempts`: `integer('attempts').notNull().default(0)`
- `startedAt`: `timestamp('started_at', { withTimezone: true })`, nullable
- `finishedAt`: `timestamp('finished_at', { withTimezone: true })`, nullable

**Indexes:**

| Index name | Columns | Type |
|---|---|---|
| `idx_job_step_run_step` | `(job_run_id, step_id)` | `uniqueIndex` — enforces no duplicate step IDs per run |
| `idx_job_step_timeline` | `(job_run_id, seq)` | `index` — ordered timeline reads |

Exported type: `export type JobStepRow = InferSelectModel<typeof jobSteps>`

### Internal `$type<>` helpers to define at top of file

```ts
type RetryPolicy = {
  attempts: number;
  backoff: 'fixed' | 'exponential';
  baseMs: number;
  nonRetryableErrors?: string[];
}

type JobRunError = {
  message: string;
  stack?: string;
  retryable: boolean;
  attempt: number;
}
```

These are not exported — they are annotation types for jsonb columns only. JOB-2 will define the full public-facing protocol types.

### `index.ts` rewrite

The barrel is rewritten to export only the new orchestration surface. All `IJobQueue`-related exports (`jobQueue`, `JobRow`, `IJobQueue`, `JOB_QUEUE`, `JobsModule`, `DrizzleJobQueue`, `BullMQJobQueue`, etc.) are removed.

```ts
// runtime/subsystems/jobs/index.ts
export { jobs, jobRuns, jobSteps } from './job-orchestration.schema';
export type { JobDefinitionRow, JobRunRow, JobStepRow } from './job-orchestration.schema';
export {
  jobRunStatusEnum,
  jobStepKindEnum,
  jobStepStatusEnum,
  collisionModeEnum,
  replayFromEnum,
  parentClosePolicyEnum,
  waitKindEnum,
  triggerSourceEnum,
} from './job-orchestration.schema';

// Subsequent issues add: protocols (JOB-2), backends (JOB-3, JOB-4),
// modules (JOB-5). All net-new — nothing from the old executor layer survives.
```

## Acceptance Criteria

- `jobs`, `jobRuns`, `jobSteps` are exported Drizzle `pgTable` objects; a bare `import` of the file throws no errors.
- `jobRunStatusEnum` values are exactly `['pending', 'running', 'waiting', 'completed', 'failed', 'timed_out', 'canceled']` — `waiting` must be present (reserved for ADR-025 without breaking schema migration later).
- Five indexes on `job_run` are declared with names: `idx_job_run_claim`, `idx_job_run_root`, `idx_job_run_scope`, `idx_job_run_dedupe`, `idx_job_run_concurrency`.
- `idx_job_run_dedupe` and `idx_job_run_concurrency` are partial indexes (`.where(...)` clause present).
- Two indexes on `job_step` are declared: `idx_job_step_run_step` as `uniqueIndex`, `idx_job_step_timeline` as `index`.
- `tenant_id` column is emitted on `job_run` only when `codegen.config.yaml: jobs.multi_tenant: true` (Q1 resolved 2026-04-19); absent from the schema when `multi_tenant` is omitted or `false`. The Hygen template uses a conditional EJS block (or two schema variants) gated on this config flag. Inline comment when emitted: `// scaffold-time conditional — see JOB-8`.
- `wait_kind`, `resume_token`, `wait_deadline` columns are present on `job_run` with inline comment `// Phase 3 placeholder — see ADR-025`; no application logic references these columns anywhere in this PR.
- `JobDefinitionRow`, `JobRunRow`, `JobStepRow` are exported `InferSelectModel` type aliases.
- All enum objects are exported from `index.ts`.
- `just test-unit` passes.

## Testing Strategy

**Unit (no Docker, no Postgres).** `src/__tests__/runtime/subsystems/job-orchestration.schema.spec.ts` (co-located with other subsystem unit tests; `just test-unit` only discovers tests under `src/__tests__/`):

- Import smoke: `import { jobs, jobRuns, jobSteps }` does not throw and each is a non-null object.
- Column presence on `job_run`: use Drizzle's `getTableColumns(jobRuns)` to enumerate columns, then assert keys `id`, `jobType`, `status`, `pool`, `runAt`, `tenantId`, `waitKind`, `resumeToken`, `waitDeadline`, `rootRunId`, `parentRunId`, `concurrencyKey`, `dedupeKey` are all present. (The `_.columns` internal-API access from the original draft is not reliable across Drizzle versions; `getTableColumns` is the documented helper.)
- Column presence on `job_step`: use `getTableColumns(jobSteps)` and assert `id`, `jobRunId`, `stepId`, `seq`, `kind`, `status`, `output`.
- Enum values: assert `jobRunStatusEnum.enumValues` includes `'waiting'` and `'timed_out'`.
- Type check (compile-time only): assign a full literal row to `JobRunRow` — verifies `InferSelectModel` resolved without `any` widening.

**Single-tenant fixture check deferred to JOB-6.** The runtime schema file is always the multi-tenant variant (`tenantId` is present). The conditional live-emit is exercised by JOB-6's Hygen template golden tests, not here.

No integration tests in this PR — JOB-3 owns the first real Postgres round-trip.

## `tenant_id` — Resolved: Scaffold-Time Conditional (2026-04-19)

**Resolved 2026-04-19 (Q1).** The `tenant_id` column is scaffold-time conditional, not unconditionally emitted.

- When `codegen.config.yaml: jobs.multi_tenant: true`: the column is included in the generated schema with comment `// scaffold-time conditional — see JOB-8`.
- When `multi_tenant` is absent or `false`: the column is not present in the schema at all.
- Enabling tenancy after initial install requires a reinstall (`subsystem install jobs`) and an Atlas migration. Acceptable per "no backwards compat until we have users" policy — clean DB state is prioritised over migration convenience.

The earlier proposal in this section (land `tenant_id` unconditionally, delegate gating to JOB-8 service layer) was reversed in favour of clean DB state. The Hygen template for `job-orchestration.schema.ts` uses a conditional EJS block gated on the `multi_tenant` config value.

**Action for JOB-1:** emit `tenantId` on `job_run` inside a conditional template block gated on `jobs.multi_tenant`. Column spec in "Interfaces and Column Definitions" reflects the multi-tenant variant; implementers must only emit the definition inside the conditional branch.

## Open Questions

- [x] **`triggerSource` as `text` vs. `pgEnum`.** **Resolved 2026-04-18: `pgEnum`.** Standing rule: closed value sets always use `pgEnum`. Phase 2 trigger source additions cost one Atlas migration each — tolerable for the typo-rejection benefit.
- [x] **`rootRunId` FK constraint.** **Resolved 2026-04-18: drop the FK, keep self-reference, generate `id` client-side via `randomUUID()` so `root_run_id = id` is settable in a single INSERT. Service layer guarantees correctness; no DB-level enforcement.**
- [x] **`seq` bigint mode.** **Resolved 2026-04-18: downgrade to `integer`. 2 billion steps per run is implausible.**

## References

- ADR-022: `docs/adrs/ADR-022-job-orchestration-domain-model.md`
- Phase 1 issue breakdown: `docs/specs/ADR-022-phase-1-issues.md`
- Pattern reference: `runtime/subsystems/jobs/job-queue.schema.ts`, `runtime/subsystems/events/domain-events.schema.ts`
