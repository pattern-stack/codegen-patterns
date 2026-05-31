---
name: integration
description: Use when working on IChangeSource<T>, ExecuteIntegrationUseCase, the integration_runs / integration_run_items audit model, cursor persistence (PostgresCursorStore / MemoryCursorStore), the DeepEqualDiffer + FieldDiffSchema contract, IntegrationModule wiring, or anything in runtime/subsystems/integration/. Load this before authoring a new IChangeSource adapter or IIntegrationSink, before touching the orchestrator loop, and before changing the changed_fields jsonb shape (ADR-0003).
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Integration Domain Skill

The integration subsystem is the generic external-system integration engine.
One orchestrator (`ExecuteIntegrationUseCase<T>`) runs every integration in
the codebase. Per-provider code implements a single port —
`IChangeSource<T>` — and per-entity code implements a single write
surface — `IIntegrationSink<T>`. Everything else (cursor persistence, diffing,
per-record audit, run lifecycle) is provided by the subsystem.

This skill covers the Phase 1 runtime (SYNC-1..SYNC-8, epic #60). Phase 2
PollChangeSource emission shipped (provider-keyed): the entity-YAML
`detection:` block is schema-validated against the canonical
`DetectionConfigSchema` (ADR-033, #226-6) and emits one
`<entity>-integration-source.module.ts` per entity (ADR-033.1 c, #251). The
generated module exposes `<ENTITY>_POLL_FETCH_REGISTRY` (consumer fills)
and `<ENTITY>_CHANGE_SOURCES: ReadonlyMap<string, IChangeSource<T>>`
(factory output via `buildChangeSource`). Webhook-side codegen + CDC
streaming emission are deferred.

Track D (provider modules + adapter scaffolds, RFC-0001) shipped in 0.12.0.
**It has no command of its own** — it runs as a post-step of `codegen entity
new` whenever `definitions/providers/*.yaml` exist. See
`protocols-and-ports.md` → "Driving Track D codegen" for the invocation,
output paths, and skip conditions before telling anyone the CLI wiring is
missing.

## Mental model

**Integration vs. jobs vs. events — three domains, one codebase:**

| System | Purpose | Unit |
|---|---|---|
| **Events** | Immutable facts about what happened | `domain_events` rows |
| **Jobs** | Stateful retryable work | `job_run` rows with status/retry |
| **Integration** | Detect upstream change → diff → apply → record | `integration_runs` + `integration_run_items` pairs |

Integration can trigger events (on successful upsert) and can be triggered by
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

`integration_run_items.changed_fields` is `{ fieldName: { from: unknown, to: unknown } }`
jsonb. Enforced at write time by `FieldDiffSchema.parse` at the recorder
boundary (ADR-0003). This lets drift-detection queries work as one-shot
SQL filters instead of payload-JSON scrapes. Every write path —
Drizzle + Memory — validates identically.

**Two enforcement points for multi-tenancy:**

When `INTEGRATION_MULTI_TENANT=true`, the orchestrator throws
`MissingTenantIdError` at `execute()` entry BEFORE opening a
`integration_runs` row (no dangling `status=running` rows), AND the Drizzle
backends independently re-validate at their write boundary. Both sites
use the shared `assertTenantId` helper so error messages match. The
memory backends accept `tenantId` and record it but do not throw —
memory state is process-local; cross-tenant isolation there isn't
meaningful.

## Task → L1 routing

| When the task involves… | Read |
|---|---|
| Designing a new `IChangeSource<T>` (signature `(subscription, cursor) => AsyncIterable<Change<T>>` per ADR-033) / `IIntegrationSink<T>` / custom `IFieldDiffer<T>` | `protocols-and-ports.md` |
| The orchestrator's run lifecycle, cursor advance, per-item failure | `orchestrator-flow.md` |
| `integration_runs` / `integration_run_items` / `integration_subscriptions` shape, `changed_fields` (ADR-0003), worked queries | `audit-model.md` |
| Writing a feature module, migrating from bespoke integration, multi-tenancy wiring | `consumer-patterns.md` |

## Non-obvious rules (read twice)

1. **One port for three modes.** Poll, CDC, and webhook adapters ALL
   implement `IChangeSource<T>` —
   `listChanges(subscription, cursor): AsyncIterable<Change<T>>`
   (#226-2 / ADR-033). Per-mode concerns (CDC replay_id, webhook
   event_id, provider-hinted changed fields) live in `Change<T>`
   metadata: `source`, `dedupKey`, `providerChangedFields`. Don't
   introduce mode-specific ports — we rejected that design explicitly.
   "CDC" here means *cursor-based event endpoints* (Stripe-style
   `events?starting_after=...`) — those map to `PollChangeSource<T>`
   with `poll.provenance: 'cdc'` (#226-4); the primitive stamps
   `Change<T>.source = 'cdc'` and reads `dedupKey` from
   `poll.cursor.field`. Long-lived stream subscriptions (SFDC
   Pub-Sub gRPC, Debezium/Kafka, Postgres logical replication) are a
   separate primitive deferred to #226-8 — they need a different
   substrate (`subscribe(onChange, onError)`, server-paced
   backpressure, ack-on-yield) and shouldn't be retrofitted here.

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
   feature module's `INTEGRATION_FIELD_DIFFER` binding.

5. **`IntegrationModule` does NOT provide `ExecuteIntegrationUseCase`.** Providing it
   there would force Nest to resolve `INTEGRATION_CHANGE_SOURCE` +
   `INTEGRATION_SINK` at module compile time, which fails before the feature
   module is imported. Consumers register `ExecuteIntegrationUseCase` in the
   same `providers` array as their source + sink bindings. Documented
   in the `integration.module.ts` header with a worked `OpportunityIntegrationModule`
   example.

6. **`DeepEqualDiffer` is wired via `useValue: new DeepEqualDiffer()`.**
   The class constructor's optional options object is reflected as an
   `Object` dependency by Nest's emit-decorator-metadata; `useValue`
   sidesteps that. Consumers binding a custom differ override the
   default via their own `INTEGRATION_FIELD_DIFFER` provider.

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

9. **`integration_subscriptions` is subsystem-owned, not consumer-owned.**
   `PostgresCursorStore` reads/writes it directly. Consumers can still
   list/query it freely for admin UIs, but don't ship an entity YAML
   for it — that would produce redundant repositories/services
   shadowing the subsystem. Same stance as `job_run`.

10. **`DetectionConfig` is the canonical filter / mapping shape.** The
    per-entity `DetectionConfig` Zod schema in
    `runtime/subsystems/integration/detection-config.schema.ts` is the single
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
- Do not provide `ExecuteIntegrationUseCase` in `IntegrationModule`. It forces
  eager resolution of consumer-owned tokens. Feature modules register
  the orchestrator alongside their source + sink bindings.
- Do not bypass `assertTenantId` when adding a new write path in a
  Drizzle backend. Every boundary that accepts `tenantId` must
  delegate to the shared helper so error messages match.
- Do not ship entity YAMLs for `integration_subscriptions` / `integration_runs` /
  `integration_run_items` — the subsystem owns the tables directly. This
  was explicitly resolved during SYNC-7 scaffold design (epic #60 §
  Phase 2 scopes `examples/integration/` YAMLs for later, not now).
- Do not create `*.deprecated.ts`, parallel shapes, or migration
  shims. No backwards compat to preserve — replace cleanly.
- Do not expand `IChangeSource` / `IIntegrationSink` protocols without an
  ADR. The narrow ports are deliberate; mode-specific richness lives
  in `Change<T>` metadata or in extension methods the consumer owns.

## Current runtime snapshot

Files that ship to the consumer app (not templates):

- `runtime/subsystems/integration/integration-change-source.protocol.ts` —
  `IChangeSource<T>`, `Change<T>`, `ChangeSource` type, `IntegrationSubscriptionView`
- `runtime/subsystems/integration/integration-cursor-store.protocol.ts` —
  `ICursorStore` with `tenantId?` signature (SYNC-4)
- `runtime/subsystems/integration/integration-field-diff.protocol.ts` —
  `IFieldDiffer<T>`, `DiffResult`, `FieldDiffSchema` (Zod — ADR-0003)
- `runtime/subsystems/integration/integration-sink.protocol.ts` — `IIntegrationSink<T>`
- `runtime/subsystems/integration/detection-config.schema.ts` —
  `DetectionConfigSchema` (Zod): discriminated union over
  `mode: 'poll' | 'webhook'`; flat-AND `ResolvedFilter` triples
  (`eq | neq | in | nin | gt | gte | lt | lte`); `CursorStrategy`
  tagged union (`systemModstamp | replayId | timestamp | eventId`);
  `poll.provenance: 'cdc'` knob (ADR-033)
- `runtime/subsystems/integration/integration-middleware.protocol.ts` —
  `ChangeIterator<T>` + `ChangeMiddleware<T>` types; the universal
  composition seam consumed by primitives (loopback ships here in
  #226-5) (ADR-033)
- `runtime/subsystems/integration/poll-change-source.ts` —
  `PollChangeSource<T>` poll-mode primitive: parameterized by a parsed
  `DetectionConfig` + `PollFetchCallback<T>`; owns filter resolution
  (flat-AND), field-mapping → `externalId`, middleware composition,
  and `Change<T>.source` provenance (`'poll'` default; `'cdc'` opt-in
  via `poll.provenance` for Stripe-style event endpoints — #226-4)
  (#226-3 / ADR-033)
- `runtime/subsystems/integration/webhook-change-source.ts` —
  `WebhookChangeSource<T>` webhook-mode primitive: parameterized by a
  parsed `DetectionConfig` (`mode: 'webhook'`) + a consumer-supplied
  `WebhookFetchCallback<T>` that iterates the consumer-owned inbound
  staging queue. Stamps `Change<T>.source = 'webhook'`, populates
  `dedupKey` from `webhook.eventIdField`, derives `externalId` from
  the mapping table's `external_id` target, composes middleware via
  the locked `ChangeMiddleware<T>` shape. Passive iterator — does NOT
  drive the orchestrator. Inbound staging-table schema is
  consumer-owned and deferred per ADR-0002 §Phase 4. (#226-4)
- `runtime/subsystems/integration/integration-run-recorder.protocol.ts` —
  `IIntegrationRunRecorder` + `StartRunInput` / `RecordItemInput` /
  `CompleteRunInput`
- `runtime/subsystems/integration/integration-loopback.protocol.ts` — optional
  `ILoopbackFingerprintStore<T>`
- `runtime/subsystems/integration/integration-audit.schema.ts` — 3 pgTables + 5
  pgEnums (scaffold-time `tenant_id` conditional owned by the Hygen
  template, not by this runtime source — matches JOB-6 / EVT-8
  pattern)
- `runtime/subsystems/integration/integration-cursor-store.drizzle-backend.ts` —
  `PostgresCursorStore`; `put()` stamps `cursor` + `last_integration_at` +
  `updated_at` in one statement so the scheduling index stays accurate
- `runtime/subsystems/integration/integration-cursor-store.memory-backend.ts` —
  `MemoryCursorStore` test double (SYNC-3)
- `runtime/subsystems/integration/integration-run-recorder.drizzle-backend.ts` —
  `DrizzleIntegrationRunRecorder`; validates `changedFields` via
  `FieldDiffSchema.parse` BEFORE insert
- `runtime/subsystems/integration/integration-run-recorder.memory-backend.ts` —
  `MemoryRunRecorder` with ergonomic helpers (`getRunsForSubscription`,
  `getItemsForRun`) for tests (SYNC-6)
- `runtime/subsystems/integration/deep-equal.differ.ts` — default
  `DeepEqualDiffer<T>` with canonical ignore list; `providerChangedFields`
  CDC hint; Date → ISO string + decimal-string ↔ number normalizations
- `runtime/subsystems/integration/execute-integration.use-case.ts` — the generic
  orchestrator. `@Optional() INTEGRATION_MULTI_TENANT`. Entry-point
  `assertTenantId` guard. Loopback suppression is composed into the
  `IChangeSource`'s middleware chain via `createLoopbackMiddleware`
  (#226-5 / ADR-033) — no orchestrator-side branch.
- `runtime/subsystems/integration/loopback.middleware.ts` —
  `createLoopbackMiddleware(store)` factory; the canonical
  `ChangeMiddleware<T>` consumers compose into their primitive's
  middleware chain when they need to suppress echoes of their own
  outbound writes (#226-5 / ADR-033)
- `runtime/subsystems/integration/integration.module.ts` —
  `IntegrationModule.forRoot({ backend, multiTenant? })`; `global: true`
- `runtime/subsystems/integration/integration.tokens.ts` — string-valued tokens
- `runtime/subsystems/integration/integration-errors.ts` — `MissingTenantIdError`
  class + `assertTenantId(tenantId, { multiTenant, operation })` shared
  helper

Generator pieces:

- `templates/entity/new/backend/modules/core/integration-source.ejs.t` —
  per-entity Phase 2 factory module emission (ADR-033.1 c, #251). One
  `<entity>-integration-source.module.ts` per entity, regardless of provider
  count; exports `<ENTITY>_POLL_FETCH_REGISTRY` +
  `<ENTITY>_CHANGE_SOURCES: ReadonlyMap<string, IChangeSource<T>>`.
- `templates/entity/new/backend/modules/core/integration-source.providers.ejs.t`
  — sibling typed-provider artifact (ADR-033.2): const tuple +
  literal-union type for compile-time consumer-registry checks.
- `templates/subsystem/integration/` — main scaffold (`prompt.js`,
  `integration-audit.schema.ejs.t`) — emitted on `subsystem install integration`
- `templates/subsystem/integration-config/` — config-block scaffold — emitted
  on first install; `--force` alone preserves an existing block,
  `--force-config` opts into regeneration (F13 pattern)
- `src/cli/shared/integration-scaffold-locals.ts` — resolves Hygen locals
  (appName, multiTenant, configPath, schemaPath — NO generatedKeepPath)

## Cross-links

- Events SKILL.md — integration can `TypedEventBus.publish(...)` after each
  successful upsert (consumer wires this; the subsystem doesn't).
- Jobs SKILL.md — integration is typically triggered by a scheduled job
  (polling) or on-demand via `action: 'manual'` from a CLI / operator
  action.
- `docs/adrs/ADR-008-subsystem-architecture.md` — Protocol → Backend
  → Factory pattern the integration subsystem follows.
- `docs/CONSUMER-SETUP.md#integration-subsystem` — fresh-install walkthrough.
- `docs/guides/integration-migration.md` — migrating from a bespoke integration
  pipeline.
- Epic #60 — authoritative decision record; `IChangeSource<T>`
  compromise analysis, ADR-0003 audit model rationale, dealbrain-v2
  extraction verdict.
