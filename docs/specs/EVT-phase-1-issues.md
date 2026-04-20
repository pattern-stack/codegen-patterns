# ADR-024 Phase 1 — Events Domain Formalization: Issue Breakdown

**Source of truth:** [ADR-024](../adrs/ADR-024-events-domain-formalization.md)
**Phase scope:** Events Phases 0 + A + C from `events-codegen-plan.md`. Ships the complete formalization: `domain_events` schema upgrade, YAML parser + Zod schema, generated artifacts (AppDomainEvent, TypedEventBus, eventRegistry, Zod schemas), Drizzle/Memory backend upgrades, EventsModule upgrade, entity `emits:` support + template updates, scaffold templates, and Atlas migration docs. Does not include the Event-to-Job Bridge (ADR-023) or selective JobEvent broadcast (Phase B / ADR-026).

**Prerequisite:** All open questions in §Open Questions below must be resolved before any EVT issue is implemented.

---

## Issue List

### EVT-1 — `domain_events` schema upgrade: `pool`, `direction`, `tenant_id` columns

**Scope.** Add three new columns to `domain_events` and add the `(pool, status, occurred_at)` composite index for pool-filtered drain queries. This is the schema foundation for all subsequent Phase A upgrades.

**Files touched.**
- `runtime/subsystems/events/domain-events.schema.ts` (modify — add columns and index)
- `runtime/subsystems/events/index.ts` (re-export `DomainEventRecord` with new fields)

**Depends on.** Nothing. This is the foundation.

**Acceptance criteria.**
- [ ] `pool text` column added, nullable, no default.
- [ ] `direction text` column added, nullable, no default.
- [ ] `tenant_id text` column added conditionally (present when `events.multi_tenant: true` in config; absent when false — following scaffold-time conditional from JOB-1/Q1 resolution).
- [ ] `(pool, status, occurred_at)` composite index declared.
- [ ] Existing indexes (`(status, occurred_at)`, `(aggregate_id, aggregate_type)`) preserved.
- [ ] Unit test asserts schema imports without error and expected column names are present.
- [ ] `DomainEventRecord` inferred type includes the new fields.

**Out of scope.** No service logic changes — DrizzleEventBus population of these columns belongs in EVT-4.

---

### EVT-2 — YAML parser and Zod schema for `events/*.yaml`

**Scope.** Zod `EventDefinitionSchema`, an `events/*.yaml` loader, cross-reference validation against known entity names, and unit tests. This is the codegen-side foundation that EVT-3 builds on.

**Files touched.**
- `src/schema/event-definition.schema.ts` (new — `EventDefinitionSchema`, `EventDefinition` type)
- `src/parser/load-events.ts` (new — loads and validates all `events/*.yaml` files)
- `src/__tests__/schema/event-definition.schema.test.ts` (new — unit tests)

**Depends on.** Nothing. Parallel with EVT-1.

**Acceptance criteria.**
- [ ] `EventDefinitionSchema` validates `type`, `direction`, `aggregate`, `source`, `destination`, `payload`, `pool`, `retry`, `version`, `description`.
- [ ] `type` must match `/^[a-z][a-z0-9_]*$/`; filename must match `type` field.
- [ ] `direction` must be `inbound | change | outbound`.
- [ ] `aggregate` is required when `direction === 'change'`; optional otherwise.
- [ ] `pool` override, when present, must be one of the three reserved event pools and consistent with the declared `direction`.
- [ ] Loader collects all `events/*.yaml`, validates each, fails hard on schema error.
- [ ] Cross-validation: a `change` event's `aggregate` must match a known entity name from the parsed entity list.
- [ ] Entity `events:` block desugaring: events declared inline in entity YAML are synthesized into `EventDefinition` objects with `direction: change` and `aggregate: <entity>` by the loader.
- [ ] Unit test: valid inbound, change, and outbound YAMLs parse correctly.
- [ ] Unit test: wrong `direction`/`aggregate` combination fails with a descriptive error.

**Out of scope.** Code generation (EVT-3). Hygen templates (EVT-8).

---

### EVT-3 — Generated artifacts: `AppDomainEvent`, `eventRegistry`, `TypedEventBus`

**Scope.** Code generator that produces five files under `runtime/subsystems/events/generated/` from the parsed `EventDefinition[]`. The generator runs as part of `just gen-all`. Includes the `TypedEventBus` class (generated per-project because its `publish<T>()` type parameter is constrained to the project's `AppDomainEvent`).

**Files touched.**
- Generator source (new or modify existing generator pipeline) to emit generated files.
- `runtime/subsystems/events/generated/types.ts` (generated — `AppDomainEvent`, interfaces, `EventTypeName`, `EventOfType<T>`, `PayloadOfType<T>`)
- `runtime/subsystems/events/generated/schemas.ts` (generated — Zod schemas, `eventPayloadSchemas`)
- `runtime/subsystems/events/generated/registry.ts` (generated — `EventMetadata`, `eventRegistry`, `getEventMetadata<T>()`)
- `runtime/subsystems/events/generated/bus.ts` (generated — `TypedEventBus` class)
- `runtime/subsystems/events/generated/index.ts` (generated — re-exports)

**Depends on.** EVT-2 (parser must produce `EventDefinition[]`).

**Acceptance criteria.**
- [ ] Generator emits all five files when `events/*.yaml` files exist; emits empty union/registry stubs when no event YAMLs exist (no error).
- [ ] Each event YAML produces one typed interface in `types.ts` with camelCase payload fields.
- [ ] `AppDomainEvent` is a discriminated union over all event interfaces.
- [ ] Each event YAML produces a Zod schema in `schemas.ts` with the correct field types (uuid/string/number/boolean/date/json mapped to Zod equivalents).
- [ ] `eventRegistry` contains one entry per event YAML with correct `direction`, `pool` (derived unless overridden), `aggregate`, `source`, `destination`, `version`, `retry`.
- [ ] `getEventMetadata<T>('contact_created')` returns `EventMetadata` narrowed to the correct entry.
- [ ] `TypedEventBus.publish<'contact_created'>()` compiles with correct payload; wrong payload is a TS error.
- [ ] `TypedEventBus.subscribe<'contact_created'>()` narrows handler param to `ContactCreatedEvent`.
- [ ] `TypedEventBus` injects `EVENT_BUS` token internally; does not bypass `IEventBus`.
- [ ] Generated files carry `// Generated. Do not edit.` header.
- [ ] Baseline snapshot test updated; `just test-baseline` passes.

**Out of scope.** Drizzle backend wiring (EVT-4). NestJS module wiring of `TypedEventBus` provider (EVT-6).

---

### EVT-4 — Drizzle backend upgrade: pool/direction columns + pool-filtered drain

**Scope.** `DrizzleEventBus.publish()` populates the new `pool` and `direction` columns from `metadata`. `processBatch()` gains a `pools?: string[]` filter argument. `EventsModule.forRoot()` gains `pools?: string[]` option. `tenant_id` is written when present in metadata.

**Files touched.**
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` (modify)
- `runtime/subsystems/events/events.module.ts` (modify — add `pools` option to `EventsModuleOptions`)

**Depends on.** EVT-1 (schema must have `pool`/`direction` columns).

**Acceptance criteria.**
- [ ] `publish(event, tx?)` extracts `event.metadata?.pool` and `event.metadata?.direction` and writes them to the dedicated columns.
- [ ] `processBatch()` when invoked with `pools: ['events_change']` only claims rows where `pool = 'events_change'`.
- [ ] `processBatch()` without `pools` argument drains all pending rows (unchanged behavior).
- [ ] `EventsModuleOptions` gains `pools?: string[]`; `EventsModule.forRoot({ pools: ['events_inbound'] })` starts a drain loop restricted to that pool.
- [ ] `tenant_id` written from `event.metadata?.tenantId` when the column exists in schema.
- [ ] Integration test (Docker Postgres): publish with `metadata.pool = 'events_change'`; drain with `pools: ['events_change']`; assert only that row is claimed; row with other pool remains `pending`.

**Out of scope.** Memory backend (EVT-5). Module-level `TypedEventBus` provider (EVT-6).

---

### EVT-5 — Memory backend upgrade + unit test suite

**Scope.** `MemoryEventBus` gains pool awareness for test assertions. A unit test suite covers publish/subscribe, pool propagation, direction stamping, tenant filtering, and pool-filtered drain simulation.

**Files touched.**
- `runtime/subsystems/events/event-bus.memory-backend.ts` (modify — pool awareness)
- `runtime/subsystems/events/__tests__/event-bus.unit.test.ts` (new — unit test suite)
- `runtime/subsystems/events/__tests__/event-bus.memory-backend.test.ts` (new or merged into above)

**Depends on.** EVT-4 (behavioral contract to match).

**Acceptance criteria.**
- [ ] `MemoryEventBus` exposes `publishedEvents` filtered by pool: `bus.publishedEventsForPool('events_change')`.
- [ ] `MemoryEventBus` tracks `direction` on each published event for test assertions.
- [ ] `MemoryEventBus` skip-pool filter: if initialized with `pools: ['events_change']`, `publish` with other pool is still stored but `dispatch` is skipped for that pool. (Matches Drizzle behavior: rows are written, only drained by the matching worker.)
- [ ] Unit test: publish two events with different pools; assert `publishedEventsForPool` returns correct subsets.
- [ ] Unit test: `subscribe` + `publish` round-trip; handler receives typed event.
- [ ] Unit test: `publishMany` dispatches all events.
- [ ] Unit test: handler error propagates synchronously (memory backend behavior unchanged).
- [ ] All tests pass in `just test-unit` (no Docker).

**Out of scope.** Integration tests against real Postgres (those are EVT-4's).

---

### EVT-6 — `EventsModule` upgrade: `TypedEventBus` provider + multi-tenancy wiring

**Scope.** Wire `TypedEventBus` as an injectable provider in `EventsModule`. `EventsModule.forRoot()` gains `multi_tenant?: boolean` option. Add `TYPED_EVENT_BUS` injection token. Multi-tenancy: when enabled, drain loop includes `tenant_id` filter.

**Files touched.**
- `runtime/subsystems/events/events.module.ts` (modify)
- `runtime/subsystems/events/events.tokens.ts` (modify — add `TYPED_EVENT_BUS` symbol)
- `runtime/subsystems/events/index.ts` (re-export `TypedEventBus`, `TYPED_EVENT_BUS`)

**Depends on.** EVT-3 (generated `TypedEventBus`), EVT-5 (memory backend parity).

**Acceptance criteria.**
- [ ] `EventsModule.forRoot()` provides `TYPED_EVENT_BUS` token resolving to a `TypedEventBus` instance.
- [ ] `TypedEventBus` is `global: true` via the module (inherited from module's `global: true`).
- [ ] `EventsModuleOptions` gains `multi_tenant?: boolean`; default `false`.
- [ ] When `multi_tenant: true`: drain loop filters by `tenant_id`; `publish` writes `tenant_id` from metadata.
- [ ] Memory backend test: `EventsModule.forRoot({ backend: 'memory' })` boots in NestJS test harness; both `EVENT_BUS` and `TYPED_EVENT_BUS` tokens resolve.
- [ ] Unit test: `TypedEventBus.publish<'contact_created'>()` compiles and dispatches through `IEventBus`.

**Out of scope.** Entity `emits:` use-case generation (EVT-7). Scaffold templates (EVT-8).

---

### EVT-7 — Entity `emits:` support + use-case template updates

**Scope.** Parse `emits:` from entity YAML; validate each entry against `events/*.yaml`; update use-case templates to call `TypedEventBus.publish()` inside transactions; emit codegen warning when `emits:` is absent. Deprecate untyped `lifecycle-events.ts` auto-emission for entities with declared `emits:`.

**Files touched.**
- `src/schema/entity-definition.schema.ts` (modify — add `emits: z.array(z.string()).optional()`)
- `src/parser/load-entities.ts` (modify — expose `emits` in parsed output, cross-validate against event registry)
- Entity use-case templates (modify — inject `TypedEventBus.publish()` call inside transaction when `emits:` declared)
- `runtime/base-classes/lifecycle-events.ts` (modify — add deprecation marker; keep as fallback path only)
- `src/__tests__/schema/entity-definition.schema.test.ts` (modify — add `emits` field tests)

**Depends on.** EVT-2 (event YAML parser — for cross-validation), EVT-3 (TypedEventBus — for generated import), EVT-6 (module wiring).

**Acceptance criteria.**
- [ ] `emits: [contact_created, contact_updated]` in entity YAML passes Zod validation.
- [ ] Each entry in `emits:` must resolve to `events/<type>.yaml` with `direction: change` and `aggregate: <entity_name>`. Missing → codegen hard error with the missing filename listed.
- [ ] Generated use-case for a create action emits `TypedEventBus.publish(type, aggregateId, payload, { tx })` inside the Drizzle transaction.
- [ ] Entities without `emits:` still generate (fallback path preserved), but `just gen` prints a warning: `Entity <name> has no emits: block. Falling back to untyped lifecycle events.`
- [ ] Entity `events:` block desugaring: entries in the entity `events:` block are synthesized into `EventDefinition` objects (no top-level `events/*.yaml` file required for entity-owned events; but if a top-level file exists with the same type, it wins).
- [ ] Baseline snapshot test updated; `just test-baseline` passes.

**Out of scope.** Inbound/outbound event generation (those are standalone `events/*.yaml` files, not entity-owned). BullMQ backend. Any events not declared in `emits:`.

---

### EVT-8 — Scaffold templates + Atlas migration docs + skill updates

**Scope.** Update `templates/subsystem/events/` to emit the new runtime files (generated artifacts, upgraded module). Add `events:` config block to `codegen.config.yaml` template. Update `docs/CONSUMER-SETUP.md`. Update `.claude/skills/events/` to reflect the new state (phase roadmap L1, remove "design in flight" caveats).

**Files touched.**
- `templates/subsystem/events/` (modify/add — emit upgraded module, tokens, new `generated/` directory with stub)
- `templates/subsystem/events/codegen-config-events-block.ejs.t` (new — `events:` config block template)
- `src/cli/commands/subsystem.command.ts` (minor — wire any new events templates to `gen-subsystem events`)
- `docs/CONSUMER-SETUP.md` (modify — add events-subsystem section; Atlas migration workflow)
- `.claude/skills/events/SKILL.md` (modify — update routing table, remove "design in flight" notes, update current-state snapshot)
- `.claude/skills/events/phase-roadmap.md` (new — what shipped in Phase 1, what's deferred to ADR-023/Phase B)
- `.claude/skills/events/event-codegen.md` (modify — remove "8 open questions unresolved" caveat; add resolved answers)

**Depends on.** EVT-6 (module must be stable before templates).

**Acceptance criteria.**
- [ ] `just gen-subsystem events` produces the new runtime files including `generated/` directory stub.
- [ ] Config block template includes `events.multi_tenant: false` and `events.backend: drizzle`.
- [ ] `docs/CONSUMER-SETUP.md` has an "Events subsystem" section covering: scaffold command, `events/*.yaml` authoring, Atlas migration, `TypedEventBus` injection.
- [ ] `just test-baseline` passes with updated snapshots.
- [ ] `.claude/skills/events/phase-roadmap.md` lists Phase 1 deliverables and what's deferred (bridge, Phase B selective broadcast).
- [ ] `SKILL.md` routing table updated with new row for phase roadmap.
- [ ] `event-codegen.md` updated to reflect resolved questions and stable generated file locations.

**Out of scope.** Entity template changes (EVT-7). Jobs bridge templates (ADR-023).

---

## Dependency Graph

```
EVT-1 (schema upgrade)
  └──▶ EVT-4 (Drizzle backend: pool columns + drain filter)
         └──▶ EVT-5 (Memory backend + unit tests)
                └──▶ EVT-6 (EventsModule + TypedEventBus wiring)
                       ├──▶ EVT-7 (emits: + use-case templates)
                       └──▶ EVT-8 (scaffold templates + docs + skill)

EVT-2 (YAML parser + Zod schema)
  └──▶ EVT-3 (generated artifacts)
         └──▶ EVT-6 (must exist before module wires TypedEventBus)
         └──▶ EVT-7 (TypedEventBus import in generated use-case)
         └──▶ EVT-2 (cross-validation in emits:)
```

Simplified critical path:

```
EVT-1 ──▶ EVT-4 ──▶ EVT-5 ──┐
EVT-2 ──▶ EVT-3 ─────────────┴──▶ EVT-6 ──▶ EVT-7
                                        └──▶ EVT-8
```

---

## Suggested Sequencing

**Wave 1 (parallel — no dependencies).**
EVT-1 (schema) and EVT-2 (YAML parser). Unblock all downstream work.

**Wave 2 (parallel — after Wave 1).**
EVT-3 (generated artifacts, after EVT-2) and EVT-4 (Drizzle backend, after EVT-1). These are independent of each other.

**Wave 3 (sequential).**
EVT-5 (Memory backend, after EVT-4). Behavioral parity requires EVT-4 to be complete first.

**Wave 4 (parallel close-out).**
EVT-6 (module upgrade, after EVT-3 + EVT-5). Once EVT-6 merges, EVT-7 and EVT-8 can proceed in parallel.

---

## Resolved Questions

**Resolved 2026-04-20.** All resolutions confirm the planner's proposed defaults; EVT-Q2 follows the user's pre-decided convention from the jobs-Q5 conversation ("the events epic will follow the same pattern with `AppDomainEvent` in `runtime/subsystems/events/generated/`"). Resolutions apply across the EVT-1..EVT-8 specs; per-spec sections reflect them where load-bearing.

1. **EVT-Q1 — `tenant_id` conditional emit on `domain_events`.**
   _Resolution:_ **Scaffold-time conditional.** Mirrors JOB-1/Q1 exactly. `tenant_id` is emitted into the schema only when `codegen.config.yaml: events.multi_tenant: true`; absent otherwise. Enabling tenancy after install requires reinstall (`subsystem install events`) + an Atlas migration. Per "no backwards compat until we have users" policy.
   _Rationale:_ Clean DB state; consistent with jobs.
   _Affects:_ EVT-1, EVT-6, EVT-8.

2. **EVT-Q2 — Generated file location.**
   _Resolution:_ **`runtime/subsystems/events/generated/`.** This is the convention established by JOB-7/Q5 (jobs-side) and was pre-decided by the user during that conversation: every subsystem-owned generated type lives under `runtime/subsystems/<subsystem>/generated/`. The original `events-codegen-plan.md` proposal of `src/generated/events/` is **superseded**.
   _Rationale:_ Clearer ownership per subsystem; uniform convention across jobs and events.
   _Affects:_ EVT-3, EVT-6, EVT-7.

3. **EVT-Q3 — Top-level `events/*.yaml` vs. entity `events:` block.**
   _Resolution:_ **Keep both.** Entity `events:` block remains as sugar; parser desugars to `EventDefinition[]` at parse time. Top-level file is optional.
   _Rationale:_ Co-location ergonomics for change events; explicit declaration available when needed.
   _Affects:_ EVT-2, EVT-7.

4. **EVT-Q4 — `emits:` strictness.**
   _Resolution:_ **Optional with codegen warning.** No `emits:` block → warning + fallback to `lifecycle-events.ts` untyped emission. `emits:` declared but referenced event YAML missing → hard error.
   _Rationale:_ Smooth migration path; strict where intent is explicit.
   _Affects:_ EVT-7.

5. **EVT-Q5 — Payload validation at `TypedEventBus.publish()`.**
   _Resolution:_ **Configurable via `CODEGEN_EVENT_VALIDATE` env flag, default on.** Use `.safeParse()` with logging on validation failure (not throwing) so a bad publish doesn't crash a hot path.
   _Rationale:_ Dev safety by default; opt-out for throughput-critical consumers.
   _Affects:_ EVT-3.

6. **EVT-Q6 — `TypedEventBus` replaces `EVENT_BUS` in generated code.**
   _Resolution:_ **Generated code uses `TypedEventBus` exclusively.** Library/framework code can still inject raw `EVENT_BUS` directly. `TypedEventBus` wraps `IEventBus`; both are exported from the module.
   _Rationale:_ Type safety where it matters (consumer code); no coexistence churn in generated output.
   _Affects:_ EVT-3, EVT-6, EVT-7.

7. **EVT-Q7 — Stale-event sweeper.**
   _Resolution:_ **No sweeper.** `FOR UPDATE SKIP LOCKED` makes the outbox drain self-healing — a crashed poller leaves the row `pending` and the next poll repicks it. `MAX_RETRIES=3 → status='failed'` covers persistent handler failures. No `claimed_at` on `domain_events`.
   _Rationale:_ Domain difference from jobs — jobs need a sweeper because workers hold rows in `running` for handler duration; events polling completes a transaction per row, no stranding window.
   _Affects:_ EVT-4.

8. **EVT-Q8 — Versioning coexistence.**
   _Resolution:_ **Defer.** `version` field on YAML exists for future use; no v1/v2 coexistence logic in Phase 1.
   _Rationale:_ Premature complexity. Lock the field shape now, add coexistence semantics when there's a real concrete migration to support.
   _Affects:_ EVT-2, EVT-3.

9. **EVT-Q9 — Pool default for event-triggered jobs (bridge concern).**
   _Resolution:_ **`batch` default.** Reserved `events_*` pools drain the bus itself; user work that reacts to an event is user work, not bus drainage.
   _Rationale:_ Avoids polluting the reserved drain lanes with arbitrary user handler latency.
   _Affects:_ EVT-7 template wiring; primarily ADR-023 (Event-to-Job Bridge — out of Phase 1 scope).
