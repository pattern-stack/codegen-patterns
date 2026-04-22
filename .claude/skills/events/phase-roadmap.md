# Phase Roadmap

What the events subsystem ships in Phase 1, what's deferred, and what you must NOT build yet. Read this when a requirement sounds like it belongs to the events subsystem but isn't covered by `EVT-1..EVT-8` — it's probably Phase B / C / 2 and the answer is "defer, or use the escape hatch listed below."

Source of truth: `docs/adrs/ADR-024-events-domain-formalization.md` §"Phase roadmap", with cross-references to ADR-022 (jobs domain), ADR-023 (event-to-job bridge), and ADR-026 (jobs observability / selective JobEvent broadcast).

## Phase 1 — Events codegen formalization (the current scope)

Delivered by `EVT-1` through `EVT-8`:

- Drizzle schema: `domain_events` outbox with first-class `pool` and `direction` columns (EVT-1); `tenant_id` emitted scaffold-time by the Hygen template when `events.multi_tenant: true` (EVT-8 precedent mirrors JOB-6).
- Protocol: `IEventBus` (narrow port — `publish / publishMany / subscribe`), unchanged by the formalization.
- Backends: Drizzle outbox poller (`FOR UPDATE SKIP LOCKED`, pool-filtered drain via `opts.pools`), Memory (sync test backend with `publishedEvents[]`, `publishedEventsForPool()`, `publishedEventsForDirection()`, `clear()`, and `opts.pools` filtering that mirrors Drizzle).
- YAML source of truth: `events/<name>.yaml` plus entity `events:` sugar that desugars to top-level files at parse time.
- Generator: `src/cli/shared/event-codegen-generator.ts` emits five files under `runtime/subsystems/events/generated/` — `types.ts` (`AppDomainEvent` union, `EventOfType<T>`, `PayloadOfType<T>`), `schemas.ts` (Zod payload schemas), `registry.ts` (`eventRegistry` keyed by type with direction/pool/aggregate/version), `bus.ts` (`TypedEventBus` facade, stamps metadata, enforces multi-tenant `tenantId`), `index.ts` (re-export surface).
- Typed facade: `TypedEventBus` injectable wrapper with `publish<T>()` / `subscribe<T>()` overloads. Stamps `metadata.pool`, `metadata.direction`, `metadata.version`. Throws `MissingTenantIdError` when `multiTenant: true` and `metadata.tenantId` is absent.
- Three directions + reserved pools: `inbound | change | outbound` → `events_inbound`, `events_change`, `events_outbound` (reserved exclusively for the outbox drain; user `@JobHandler` decorations targeting a reserved pool fail at build time — see jobs SKILL.md).
- NestJS module: `EventsModule.forRoot({ backend, multiTenant?, pools? })`, `global: true`; provides `EVENT_BUS`, `TYPED_EVENT_BUS`, `EVENTS_MULTI_TENANT`.
- Scaffold: `just gen-subsystem events` (backends = `drizzle | memory`; Redis backend exists as runtime file but is not offered via the Phase 1 scaffold surface).
- Hygen templates: `templates/subsystem/events/` emits `events:` block in `codegen.config.yaml`, `domain-events.schema.ts` with tenant gate, and `.gitkeep` under `generated/`.
- Multi-tenancy opt-in via `events.multi_tenant: true` in config.
- CONSUMER-SETUP docs section for the events subsystem.

Nothing else in the events domain is Phase 1.

## Phase 2 — Event-to-Job Bridge (ADR-023)

**Defined, not shipped.** ADR-023 revised 2026-04-21; BRIDGE-1..9 specs cut from `docs/specs/BRIDGE-PHASE-2-PLAN.md`. Implementation pending.

The bridge is its **own subsystem** at `runtime/subsystems/bridge/` — the *combiner* of events and jobs, owned by neither. Seven locked decisions:

1. **Triggers are job-owned** via `@JobHandler({ triggers: [{ event, map, when }] })`. Events subsystem stays zero-knowledge about jobs.
2. **Bridge IS the jobs worker** draining reserved `events_*` pools. Each delivery produces a wrapper `job_run` (framework-owned `@framework/bridge_delivery`) + a `bridge_delivery` ledger row; the wrapper handler spawns the user-pool job.
3. **Typed TS callbacks** for `map:` / `when:` (not YAML DSL) — typechecked against `PayloadOfType<T>`.
4. **Four-state `bridge_delivery.status`** (`pending | delivered | skipped | failed`). No auto-retry; wrapper's own retry policy handles infra blips.
5. **Build-time validation** against `eventRegistry` — unknown event types hard-error at `just gen-all`.
6. **`when:` predicates** ship in Phase 2.
7. **`IEventFlow` facade** with two verbs — `publish()` and `publishAndStart()` — as the injectable request-path surface. Collision between `publishAndStart` + a declared `triggers:` entry is resolved by pre-writing `bridge_delivery(status=delivered)` so the drain's `UNIQUE(event_id, trigger_id)` dedups.

Three-tier model (see ADR-023 §*Three tiers of event-driven work*):

| Tier | Mechanism | Durability | Latency |
|---|---|---|---|
| 1. Subscribe | `IEventBus.subscribe()` / `@OnEvent` in-process | None | ~ms |
| 2. Direct invoke | `eventFlow.publishAndStart(...)` | Yes (caller tx) | ~1 poll cycle |
| 3. Bridge | `@JobHandler({ triggers: [...] })` | Yes (outbox + ledger) | 2–3 poll cycles |

A new CLI — `codegen events consumers <type>` — indexes all three tiers and ships in Phase 2 (BRIDGE-9).

Depends on the shipped events registry (Phase 1) — that's why EVT-1..EVT-8 had to land first. Until BRIDGE-1..9 merge:
- **Do NOT** subscribe a heavy handler directly to `IEventBus` inside a consumer service. Publish the event from the use case (inside the transaction), and enqueue a job from a separate use case call site rather than inside a subscriber. Subscribers that make HTTP/external calls block the outbox drain.
- If you absolutely need a reactive bridge today, write a thin subscriber that calls `IJobOrchestrator.start(...)` and nothing else. Leave a `// TODO(ADR-023)` comment so the generated bridge can replace it cleanly.

## Phase B — Selective JobEvent broadcast (ADR-026)

Not in Phase 1. Adds:
- `job_event` audit table (jobs subsystem).
- `JobEventLogger` service emitting lifecycle events (`job_run_started`, `job_run_completed`, `job_run_failed`, etc.).
- Selective broadcast rules that route a subset of job lifecycle events through `IEventBus` as `inbound` / `change` events for cross-subsystem observers.

In Phase 1, the events subsystem does not carry job lifecycle signals. If a consumer wants "notify when this job finishes," two options exist until Phase B lands:
- Publish an explicit domain event from the job handler body itself (`await typedBus.publish('<name>', aggregateId, payload, { tx })`), owned by the handler.
- Read `job_run` / `job_step` rows directly for operational dashboards.

Leave a `// TODO(EVT-phase-b)` comment where you would have subscribed to a job lifecycle event, so the selective-broadcast wiring can replace the explicit emit.

## Phase C — Versioning coexistence

Not in Phase 1. Adds:
- Multi-version coexistence: `eventRegistry[type].version` used to dispatch between versioned payload shapes (`contact_created@1`, `contact_created@2`).
- Deprecation workflow for retiring an old version once all subscribers have migrated.
- Upcaster hooks at the publish boundary for transparent version bumps in the outbox.

Phase 1 stamps `metadata.version` onto every publish (via `TypedEventBus`) but does not route on it. Subscribers see a single shape per type. **Do not** ship a second version of an event in Phase 1 — add the new field to the existing schema and treat absent values as `undefined`. If the semantics genuinely diverge, introduce a new event type instead (`contact_created` → `contact_provisioned`).

Entity auto-emission (Phase C target design): entities declare `emits: [contact_created, contact_updated, ...]` and generated use-cases emit typed events inside the transaction. Silent auto-emission by name (the legacy `runtime/base-classes/lifecycle-events.ts` pattern) is being phased out.

## Explicit "do not build this yet" list

Work items that look adjacent but are out of scope for Phase 1:

| Thing | Reason it's out of scope | What to do instead |
|---|---|---|
| Event-to-Job bridge / `job_trigger` / `bridge_delivery` | Phase 2 (ADR-023). | Enqueue jobs from use cases; thin subscriber with `// TODO(ADR-023)`. |
| `job_event` audit table / selective JobEvent broadcast | Phase B (ADR-026). | Publish explicit domain events from handler bodies; read `job_run` directly. |
| Multi-version event dispatch (`contact_created@1` vs `@2`) | Phase C. | Evolve schema in place; introduce a new event type if semantics diverge. |
| Outbox sweeper / retry scheduler for failed deliveries | Resolved EVT-Q7 — rejected for Phase 1. | Rely on the drain loop's pool-filtered claim + handler idempotency. Stuck rows are a manual ops concern until Phase 2+. |
| Redis backend scaffold option | Runtime file exists but not in the Phase 1 scaffold surface. | Use `drizzle` or `memory`. |
| Arbitrary side-effects in subscribers (HTTP, Slack, sync push) | Blocks the outbox drain. | Enqueue an `events_outbound` job with retry/timeout; leave `// TODO(ADR-023)` if the bridge would replace it. |
| `status`/`attempts`/`retry_policy` fields on events | Events are immutable facts — they have no lifecycle. | Model the work as a job. See jobs SKILL.md. |
| Collapsing `inbound` / `change` / `outbound` into one pool | Lane isolation is the whole point (ADR-024). | Keep three pools. A slow outbound handler must not stall change propagation. |
| New protocol methods on `IEventBus` | Narrow port is deliberate. Typing/routing/metadata live in the typed facade. | Extend `TypedEventBus` or wire a new facade; open an ADR if the port genuinely needs a new method. |
| `*.deprecated.ts` / parallel old+new event shapes | No external consumers yet (CLAUDE.md operating principles). | Replace cleanly. |

## Signalling "this is deferred" in code

When you add a feature that touches the events subsystem, and you hit a boundary that needs Phase 2 / B / C:

1. Don't invent a workaround in `runtime/subsystems/events/`. That's how the old untyped `type: string` + `payload: Record<string, unknown>` shape built up tech debt.
2. Write the Phase-1-compatible shape (explicit publish inside the transaction; use-case-driven job enqueue rather than reactive subscriber).
3. Leave a comment at the call site so the future phase work can grep it:
   - `// TODO(ADR-023)` — would be generated by the event-to-job bridge.
   - `// TODO(EVT-phase-b)` — would be replaced by selective JobEvent broadcast wiring.
   - `// TODO(EVT-phase-c)` — versioning / coexistence concern.

If the requirement genuinely can't wait, escalate — draft a new spec against the relevant future-phase ADR rather than sneaking the feature into Phase 1.

## Cross-links

- `docs/adrs/ADR-024-events-domain-formalization.md` — authoritative ADR for Phase 1.
- `docs/adrs/ADR-023-event-to-job-bridge.md` — Phase 2.
- `docs/adrs/ADR-026-job-observability.md` — Phase B (selective JobEvent broadcast).
- `docs/adrs/ADR-022-job-orchestration-domain-model.md` — jobs side of the pools story; reserved `events_*` pools originate here.
- `../jobs/phase-roadmap.md` — sibling roadmap; note that the event-to-job bridge is cataloged on both sides.
- `docs/specs/events-codegen-plan.md` — superseded plan (historical context only).
