---
name: sync
description: Use when working on IChangeSource<T>, ExecuteSyncUseCase, the sync_runs / sync_run_items audit model, cursor persistence (PostgresCursorStore / MemoryCursorStore), the DeepEqualDiffer + FieldDiffSchema contract, SyncModule wiring, or anything in runtime/subsystems/sync/. Load this before authoring a new IChangeSource adapter or ISyncSink, before touching the orchestrator loop, and before changing the changed_fields jsonb shape (ADR-0003).
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Sync Domain Skill

The sync subsystem is the generic external-system integration engine.
One orchestrator (`ExecuteSyncUseCase<T>`) runs every integration in
the codebase. Per-provider code implements a single port —
`IChangeSource<T>` — and per-entity code implements a single write
surface — `ISyncSink<T>`. Everything else (cursor persistence, diffing,
per-record audit, run lifecycle) is provided by the subsystem.

This skill covers the Phase 1 runtime (SYNC-1..SYNC-8, epic #60). Phase
2 lands in two halves: the entity-YAML `detection:` block is now
schema-validated upstream against the canonical `DetectionConfigSchema`
(ADR-033, #226-6); the codegen factory-module emission that consumes
the parsed block is still pending (#226-7).

## Mental model

**Sync vs. jobs vs. events — three domains, one codebase:**

| System | Purpose | Unit |
|---|---|---|
| **Events** | Immutable facts about what happened | `domain_events` rows |
| **Jobs** | Stateful retryable work | `job_run` rows with status/retry |
| **Sync** | Detect upstream change → diff → apply → record | `sync_runs` + `sync_run_items` pairs |

Sync can trigger events (on successful upsert) and can be triggered by
jobs (scheduled polling) or webhooks — but the three are distinct
subsystems with different lifecycles. Don't collapse them.

**Five-step dance — the invariant every integration repeats:**

1. detect upstream change
2. diff against local state
3. apply (upsert or soft-delete)
4. record delta
5. emit event (consumer-owned wiring)

Steps 2–5 are machinery the subsystem owns. Step 1 is the `IChangeSource<T>`
port — per-provider, per-entity, per-detection-mode. Three detection
modes (poll / CDC / webhook) converge on the same port; per-mode
differences live in `Change<T>` metadata (`source`, `dedupKey`,
`providerChangedFields`), not in separate ports. That was a deliberate
compromise rejecting an `IPollSource` / `ICdcSource` / `IWebhookSource`
split — see epic #60's design notes.

**Audit model — structured, not freeform:**

`sync_run_items.changed_fields` is `{ fieldName: { from: unknown, to: unknown } }`
jsonb. Enforced at write time by `FieldDiffSchema.parse` at the recorder
boundary (ADR-0003). This lets drift-detection queries work as one-shot
SQL filters instead of payload-JSON scrapes. Every write path —
Drizzle + Memory — validates identically.

**Two enforcement points for multi-tenancy:**

When `SYNC_MULTI_TENANT=true`, the orchestrator throws
`MissingTenantIdError` at `execute()` entry BEFORE opening a
`sync_runs` row (no dangling `status=running` rows), AND the Drizzle
backends independently re-validate at their write boundary. Both sites
use the shared `assertTenantId` helper so error messages match. The
memory backends accept `tenantId` and record it but do not throw —
memory state is process-local; cross-tenant isolation there isn't
meaningful.

## Task → L1 routing

| When the task involves… | Read |
|---|---|
| Designing a new `IChangeSource<T>` (signature `(subscription, cursor) => AsyncIterable<Change<T>>` per ADR-033) / `ISyncSink<T>` / custom `IFieldDiffer<T>` | `protocols-and-ports.md` |
| The orchestrator's run lifecycle, cursor advance, per-item failure, loopback | `orchestrator-flow.md` |
| `sync_runs` / `sync_run_items` / `sync_subscriptions` shape, `changed_fields` (ADR-0003), worked queries | `audit-model.md` |
| Writing a feature module, migrating from bespoke sync, multi-tenancy wiring | `consumer-patterns.md` |

## Non-obvious rules (read twice)

1. **One port for three modes.** Poll, CDC, and webhook adapters ALL
   implement `IChangeSource<T>` —
   `listChanges(subscription, cursor): AsyncIterable<Change<T>>`
   (#226-2 / ADR-033). Per-mode concerns (CDC replay_id, webhook
   event_id, provider-hinted changed fields) live in `Change<T>`
   metadata: `source`, `dedupKey`, `providerChangedFields`. Don't
   introduce mode-specific ports — we rejected that design explicitly.

2. **Cursors are opaque at the port seam, and the orchestrator owns
   the lifecycle.** `ICursorStore.get/put` takes `unknown`. Each
   strategy types its cursor internally (poll: `{ systemModstamp }`,
   CDC: `{ replayId }`, webhook: `{ ts }`). The orchestrator is the
   only reader of `ICursorStore` — it `get`s the cursor before the
   run, passes it by value as the second argument to
   `IChangeSource.listChanges(subscription, cursor)` (#226-2 / ADR-033),
   advances `latestCursor = change.cursor` as the iterator yields,
   and `put`s on success. Primitives never inject `ICursorStore`;
   that would create two readers of the same row. The orchestrator
   doesn't interpret the cursor shape; it just persists what the
   iterator last yielded.

3. **All-failed runs still advance the cursor.** If every record in a
   run fails, `status='failed'` is recorded but the cursor still
   persists as last-yielded. Rationale: the source kept yielding;
   re-running would not re-deliver those records. Retry semantics
   (dead-letter replay, `action: 'manual'`) are caller-owned. Document
   this in consumer runbooks — it's the most common "wait, what?"
   moment during first-run adoption.

4. **Created-record diffs include every non-null user field.** The
   default `DeepEqualDiffer` ignores only row metadata (`id`,
   `createdAt`, `updatedAt`, `deletedAt`, `type`, `lastModifiedAt`,
   `fields`, `providerMetadata`). Domain fields — including
   identifiers like `external_id` — are legitimately part of the diff
   for a newly-created record. If a consumer wants to trim extras,
   augment via `new DeepEqualDiffer({ ignore: [...] })` in their
   feature module's `SYNC_FIELD_DIFFER` binding.

5. **`SyncModule` does NOT provide `ExecuteSyncUseCase`.** Providing it
   there would force Nest to resolve `SYNC_CHANGE_SOURCE` +
   `SYNC_SINK` at module compile time, which fails before the feature
   module is imported. Consumers register `ExecuteSyncUseCase` in the
   same `providers` array as their source + sink bindings. Documented
   in the `sync.module.ts` header with a worked `OpportunitySyncModule`
   example.

6. **`DeepEqualDiffer` is wired via `useValue: new DeepEqualDiffer()`.**
   The class constructor's optional options object is reflected as an
   `Object` dependency by Nest's emit-decorator-metadata; `useValue`
   sidesteps that. Consumers binding a custom differ override the
   default via their own `SYNC_FIELD_DIFFER` provider.

7. **`completeRun` does NOT re-check tenancy** when `multiTenant=true`.
   The run id was returned by `startRun` which already enforced it;
   run ids are uuids, not guessable cross-tenant. Matches JOB-3's
   pattern of trusting the run id for downstream mutations. Don't add
   a guard there without an ADR.

8. **ADR-0003 `FieldDiffSchema` is enforced at the recorder boundary,
   not the column.** The `changed_fields` jsonb column has `$type<FieldDiff>`
   annotation but the runtime gate is `FieldDiffSchema.parse(input.changedFields)`
   in `recordItem`. Both Drizzle + Memory backends call parse — a
   memory recorder that skipped the validation would be a silently
   weaker contract than production.

9. **`sync_subscriptions` is subsystem-owned, not consumer-owned.**
   `PostgresCursorStore` reads/writes it directly. Consumers can still
   list/query it freely for admin UIs, but don't ship an entity YAML
   for it — that would produce redundant repositories/services
   shadowing the subsystem. Same stance as `job_run`.

10. **`DetectionConfig` is the canonical filter / mapping shape.** The
    per-entity `DetectionConfig` Zod schema in
    `runtime/subsystems/sync/detection-config.schema.ts` is the single
    source of truth for filter, field-mapping, and cursor-strategy
    shape across the subsystem. Runtime primitives
    (`PollChangeSource<T>` / `WebhookChangeSource<T>`) parse it at
    construction; the codegen YAML validator imports the same schema;
    the per-entity factory module emitted by Phase 2 codegen consumes
    its parsed value. Primitives and codegen factories must derive
    their behavior from `DetectionConfig` rather than inline literals
    — drift between the two sites must be a compile error, not a
    runtime mismatch. See ADR-033 (`docs/adrs/ADR-033-config-driven-change-sources.md`).

11. **`userId` / `tenantId` are NOT in `PollFetchContext`.** The poll
    primitive's adapter callback receives exactly
    `{ subscription, cursor, filters }` (decision memo Q5). Run-scope
    identity (`userId`, `tenantId`) is closed over by the consumer at
    adapter construction (or resolved inside the callback via consumer
    services) — never threaded through the port seam. Threading it
    forces port expansion every time run-context grows, and the
    orchestrator already enforces tenancy at `execute()` entry. The
    same rule applies to `WebhookChangeSource<T>` when it lands in
    #226-4. See ADR-033 + decision memo Q5.

## Do not

- Do not introduce `IPollSource`, `ICdcSource`, or `IWebhookSource`.
  The `IChangeSource<T>` union is deliberate. See epic #60 compromise
  analysis.
- Do not treat `changed_fields` as freeform jsonb. The `{ from, to }`
  per-field shape is load-bearing for drift-detection queries and
  enforced at write. Adding arbitrary keys breaks consumers.
- Do not provide `ExecuteSyncUseCase` in `SyncModule`. It forces
  eager resolution of consumer-owned tokens. Feature modules register
  the orchestrator alongside their source + sink bindings.
- Do not bypass `assertTenantId` when adding a new write path in a
  Drizzle backend. Every boundary that accepts `tenantId` must
  delegate to the shared helper so error messages match.
- Do not ship entity YAMLs for `sync_subscriptions` / `sync_runs` /
  `sync_run_items` — the subsystem owns the tables directly. This
  was explicitly resolved during SYNC-7 scaffold design (epic #60 §
  Phase 2 scopes `examples/sync/` YAMLs for later, not now).
- Do not create `*.deprecated.ts`, parallel shapes, or migration
  shims. No backwards compat to preserve — replace cleanly.
- Do not expand `IChangeSource` / `ISyncSink` protocols without an
  ADR. The narrow ports are deliberate; mode-specific richness lives
  in `Change<T>` metadata or in extension methods the consumer owns.

## Current runtime snapshot

Files that ship to the consumer app (not templates):

- `runtime/subsystems/sync/sync-change-source.protocol.ts` —
  `IChangeSource<T>`, `Change<T>`, `ChangeSource` type, `SyncSubscriptionView`
- `runtime/subsystems/sync/sync-cursor-store.protocol.ts` —
  `ICursorStore` with `tenantId?` signature (SYNC-4)
- `runtime/subsystems/sync/sync-field-diff.protocol.ts` —
  `IFieldDiffer<T>`, `DiffResult`, `FieldDiffSchema` (Zod — ADR-0003)
- `runtime/subsystems/sync/sync-sink.protocol.ts` — `ISyncSink<T>`
- `runtime/subsystems/sync/detection-config.schema.ts` —
  `DetectionConfigSchema` (Zod): discriminated union over
  `mode: 'poll' | 'webhook'`; flat-AND `ResolvedFilter` triples
  (`eq | neq | in | nin | gt | gte | lt | lte`); `CursorStrategy`
  tagged union (`systemModstamp | replayId | timestamp | eventId`);
  `poll.provenance: 'cdc'` knob (ADR-033)
- `runtime/subsystems/sync/sync-middleware.protocol.ts` —
  `ChangeIterator<T>` + `ChangeMiddleware<T>` types; the universal
  composition seam consumed by primitives (loopback ships here in
  #226-5) (ADR-033)
- `runtime/subsystems/sync/poll-change-source.ts` —
  `PollChangeSource<T>` poll-mode primitive: parameterized by a parsed
  `DetectionConfig` + `PollFetchCallback<T>`; owns filter resolution
  (flat-AND), field-mapping → `externalId`, middleware composition,
  and `Change<T>.source` provenance (`'poll'` default; `'cdc'` opt-in
  via `poll.provenance` for Stripe-style event endpoints — #226-4)
  (#226-3 / ADR-033)
- `runtime/subsystems/sync/sync-run-recorder.protocol.ts` —
  `ISyncRunRecorder` + `StartRunInput` / `RecordItemInput` /
  `CompleteRunInput`
- `runtime/subsystems/sync/sync-loopback.protocol.ts` — optional
  `ILoopbackFingerprintStore<T>`
- `runtime/subsystems/sync/sync-audit.schema.ts` — 3 pgTables + 5
  pgEnums (scaffold-time `tenant_id` conditional owned by the Hygen
  template, not by this runtime source — matches JOB-6 / EVT-8
  pattern)
- `runtime/subsystems/sync/sync-cursor-store.drizzle-backend.ts` —
  `PostgresCursorStore`; `put()` stamps `cursor` + `last_sync_at` +
  `updated_at` in one statement so the scheduling index stays accurate
- `runtime/subsystems/sync/sync-cursor-store.memory-backend.ts` —
  `MemoryCursorStore` test double (SYNC-3)
- `runtime/subsystems/sync/sync-run-recorder.drizzle-backend.ts` —
  `DrizzleSyncRunRecorder`; validates `changedFields` via
  `FieldDiffSchema.parse` BEFORE insert
- `runtime/subsystems/sync/sync-run-recorder.memory-backend.ts` —
  `MemoryRunRecorder` with ergonomic helpers (`getRunsForSubscription`,
  `getItemsForRun`) for tests (SYNC-6)
- `runtime/subsystems/sync/deep-equal.differ.ts` — default
  `DeepEqualDiffer<T>` with canonical ignore list; `providerChangedFields`
  CDC hint; Date → ISO string + decimal-string ↔ number normalizations
- `runtime/subsystems/sync/execute-sync.use-case.ts` — the generic
  orchestrator. `@Optional() SYNC_LOOPBACK_FINGERPRINT_STORE` +
  `@Optional() SYNC_MULTI_TENANT`. Entry-point `assertTenantId` guard
- `runtime/subsystems/sync/sync.module.ts` —
  `SyncModule.forRoot({ backend, multiTenant? })`; `global: true`
- `runtime/subsystems/sync/sync.tokens.ts` — string-valued tokens
- `runtime/subsystems/sync/sync-errors.ts` — `MissingTenantIdError`
  class + `assertTenantId(tenantId, { multiTenant, operation })` shared
  helper

Generator pieces:

- `templates/subsystem/sync/` — main scaffold (`prompt.js`,
  `sync-audit.schema.ejs.t`) — emitted on `subsystem install sync`
- `templates/subsystem/sync-config/` — config-block scaffold — emitted
  on first install; `--force` alone preserves an existing block,
  `--force-config` opts into regeneration (F13 pattern)
- `src/cli/shared/sync-scaffold-locals.ts` — resolves Hygen locals
  (appName, multiTenant, configPath, schemaPath — NO generatedKeepPath)

## Cross-links

- Events SKILL.md — sync can `TypedEventBus.publish(...)` after each
  successful upsert (consumer wires this; the subsystem doesn't).
- Jobs SKILL.md — sync is typically triggered by a scheduled job
  (polling) or on-demand via `action: 'manual'` from a CLI / operator
  action.
- `docs/adrs/ADR-008-subsystem-architecture.md` — Protocol → Backend
  → Factory pattern the sync subsystem follows.
- `docs/CONSUMER-SETUP.md#sync-subsystem` — fresh-install walkthrough.
- `docs/guides/sync-migration.md` — migrating from a bespoke sync
  pipeline.
- Epic #60 — authoritative decision record; `IChangeSource<T>`
  compromise analysis, ADR-0003 audit model rationale, dealbrain-v2
  extraction verdict.
