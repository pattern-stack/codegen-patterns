# ADR-023 — Event-to-Job Bridge

**Status:** Draft
**Date:** 2026-04-21
**Owner:** Doug
**Related:** ADR-022 (Job Orchestration Domain Model), ADR-024 (Events Domain Formalization), ADR-008 (Subsystem Architecture)
**Depends on:** ADR-024 Phase 1 (shipped via EVT-1..EVT-8) — typed event registry, `TypedEventBus`, direction-routed outbox
**Unblocks:** ADR-026 (JobEvent Observability — selective job lifecycle → events broadcast)

## Context

ADR-024 established events as immutable facts published through a transactional outbox (`domain_events`), with pool-filtered drain and three directions (`inbound | change | outbound`). ADR-022 established jobs as durable stateful work (`job_run`) with hierarchy, scope, retry policy, and pool-based concurrency. The two subsystems meet at a specific seam: **some events should trigger jobs**.

Today, that seam is hand-written: a consumer subscribes via `IEventBus.subscribe()` and calls `IJobOrchestrator.start()` from inside the subscriber. This works, but:

1. **Subscribers that do real work block the outbox drain.** The events skill explicitly warns against this ("subscribers should enqueue a job, not do heavy work inline"). Without a formalized bridge, every consumer re-implements the same "thin subscriber calls orchestrator" pattern, incorrectly.
2. **There is no idempotency ledger.** If the outbox replays an event (drain worker crash, at-least-once delivery), a naive subscriber spawns duplicate `job_run` rows. Every consumer needs to implement their own dedupe.
3. **There is no typed binding.** The subscriber writes `ev.payload as { accountId: string }` — the registry knows the payload shape but the subscriber doesn't consult it.
4. **There is no control plane.** An operator who wants to pause event-driven fanout (during a migration, during an incident) has no single knob. They either stop the outbox (kills everything including in-process subscribers) or set flags in N services.
5. **The reserved `events_inbound | events_change | events_outbound` pools exist but have no behavior.** ADR-022 reserved them against user handlers "for the bridge." Until the bridge lands, the reservation is a guard with no occupant.

The bridge closes that seam. It is the single, formalized, typed, observable path from "an event was published" to "a job was started in response." It is **owned by neither the events subsystem nor the jobs subsystem** — it's a narrow layer between them.

## Decision

### Architectural spine vs. authoring surface

Split the bridge into two layers with different change cost:

| Layer | What lives here | Cost to change after ship |
|---|---|---|
| **Spine** (runtime contract) | `IJobBridge` protocol, `bridge_delivery` table, `bridgeRegistry` shape, wrapper-run execution model | High — schema migration or protocol bump |
| **Authoring surface** | How users declare triggers: decorator form, optional YAML form, `map:` / `when:` / `scope:` fields | Low — pure codegen, no runtime impact |

The spine is opinionated and minimal. The authoring surface is free to grow; new authoring styles compile down to the same `bridgeRegistry` without touching the runtime.

This matches the core-contract + extensions pattern from CLAUDE.md: the spine guarantees portability and observability; authoring styles layer on top additively.

### Six locked decisions

#### 1. Triggers are job-owned, declared on the handler

```ts
@JobHandler({
  type: 'send_welcome_email',
  pool: 'outbound_email',
  triggers: [
    { event: 'user.created', map: (e) => ({ userId: e.aggregateId }) },
  ],
})
class SendWelcomeEmailJob { /* ... */ }
```

Rationale: the handler already owns pool, concurrency, replay, retry. Declaring "which events I care about" alongside is the locality that matches how authors think. The event subsystem stays zero-knowledge about jobs — the registry is built by codegen scanning handler decorators, not event YAML.

**Reversal cost:** low. A future YAML authoring style (`triggers/*.yaml`) can be added as a second codegen source producing into the same `bridgeRegistry`. Both styles can coexist.

#### 2. Execution: the bridge IS the jobs worker draining reserved pools

The bridge is not a separate worker process, not a subscriber on `IEventBus`, and not inline in the outbox drain. It is **framework-provided `@JobHandler` classes that run on the reserved `events_*` pools**, claimed by the ordinary job worker.

Flow:

```
┌─────────────────────┐
│  Use case (in tx)   │
│  typedBus.publish() │
└──────────┬──────────┘
           ▼
  ┌────────────────┐
  │ domain_events  │  row inserted in same transaction
  │ pool=events_*  │  direction stamped by TypedEventBus
  └───────┬────────┘
          │ outbox drain (Drizzle poller, FOR UPDATE SKIP LOCKED)
          ▼
  ┌─────────────────┐   ┌──────────────────────────────┐
  │ bridge_delivery │ + │ job_run                      │
  │ (audit row)     │   │ type=@framework/bridge       │
  └─────────────────┘   │ pool=events_<direction>      │
                        │ status=pending               │
                        └────────────┬─────────────────┘
                                     │ job worker claims (FOR UPDATE SKIP LOCKED)
                                     ▼
                        ┌──────────────────────────────┐
                        │ BridgeDeliveryHandler        │
                        │  reads bridge_delivery       │
                        │  orchestrator.start(userJob) │
                        │  updates bridge_delivery     │
                        └────────────┬─────────────────┘
                                     │ spawns child run
                                     ▼
                        ┌──────────────────────────────┐
                        │ job_run (user job)           │
                        │ type=send_welcome_email      │
                        │ pool=outbound_email          │
                        │ parent_run_id=wrapper.id     │
                        │ trigger_source=event         │
                        │ trigger_ref=<event_id>       │
                        └──────────────────────────────┘
```

Rationale: reusing `job_run` machinery (pool concurrency, retry, cancellation cascade, memoization, observability) for bridge deliveries is strictly cheaper than building parallel versions of all those features for `bridge_delivery`. Every operational capability the jobs subsystem already has applies to bridge fanout for free:

- **Pause fanout globally**: `jobs.pools.events_change.concurrency = 0` holds wrappers in `pending`. Flip back on, they drain.
- **Throttle fanout**: pool concurrency limit.
- **Retry bridge delivery on infra blip**: wrapper's own retry policy.
- **Cancel fanout tree**: cancel the wrapper → cascade via `parent_run_id` + `parent_close_policy`.
- **Delay / debounce**: wrapper has `run_at`; schedule it.
- **Observability**: wrappers show up in the jobs dashboard like any other run. Every Airflow/Temporal-style view gets bridge activity for free.

Cost: 2× `job_run` rows per fanout (wrapper + user job), and one extra claim-cycle of latency between event arrival and user job start (≈ poll interval). At realistic event rates (100s–1000s/sec), this is not a concern. At 10k+/sec, revisit.

The reserved `events_*` pools now have a real function: they are **the pools where bridge-delivery wrappers run**. The reservation rule (user `@JobHandler` cannot target them) stands unchanged — it exists because the framework's own bridge-delivery handlers live there.

**Reversal cost:** medium. Old wrapper `job_run` rows would be orphaned but benign if a future implementation skipped wrappers. Mitigation: the `@framework/bridge_delivery` handler type name makes them filterable for dashboard hiding and cleanup.

#### 3. Typed TS callbacks for `map:` and `when:`, not a YAML DSL

```ts
triggers: [
  {
    event: 'contact.updated',
    map: (e) => ({ contactId: e.aggregateId, fields: Object.keys(e.payload.changes) }),
    when: (e) => e.payload.changes.hubspotSynced !== false,
  },
]
```

Rationale: `map:` and `when:` are fundamentally expressions over the typed event payload. TS gives us type-checking against `eventRegistry[type]`, refactor-safety, and arbitrary expressiveness. A YAML path DSL would re-invent lodash `get()` and fail the moment a consumer needs `Object.keys()` or a conditional.

**Reversal cost:** low. A YAML authoring style could add `map: "payload.userId"` as sugar that compiles to `(e) => e.payload.userId`. Both coexist.

#### 4. Failure policy: `bridge_delivery.status` four-state, no auto-retry

State enum: `pending | delivered | skipped | failed`.

- `pending` — wrapper run exists, hasn't successfully started user job yet.
- `delivered` — user job started, `user_run_id` populated.
- `skipped` — intentional no-op (e.g., `when:` predicate returned false, or dedupe collision returned incumbent run id).
- `failed` — wrapper handler exhausted its retry policy. Ops-visible via dashboard; no automatic retry past the wrapper's own retry policy.

Rationale: mirrors the events outbox stance (no sweeper in Phase 1). Infra blips are absorbed by the wrapper's normal retry policy. Persistent failure means a broken trigger, broken map, or unreachable orchestrator — all of which need human eyes, not more retries.

**Reversal cost:** low. Adding a `retrying` status + retry scheduler later is additive. Indexing may need rework.

#### 5. Build-time validation against `eventRegistry`

Codegen validates every `triggers[].event` against the generated `eventRegistry` at `just gen-all` time:

- Unknown event type → hard error, generation fails.
- `map:` signature mismatch (wrong payload type) → caught by TS typecheck against `PayloadOfType<T>`.
- User-pool coherence: the user job's pool (`@JobHandler.pool`) is free — it does not need to match the event's direction-routed pool. The wrapper lives in `events_<direction>`; the user job lives wherever its handler declares. This is the two-step pipeline.
- Reserved-pool targeting by a user job still fails at module init per ADR-022. A trigger cannot circumvent that: the wrapper is framework-owned, the user job lives in its declared user pool.

Rationale: the typed registry is the single source of truth for "what events exist." Every other path (string matches, runtime subscribers) degrades that guarantee.

**Reversal cost:** none — this is a pure build-time concern, removable without runtime impact.

#### 6. `when:` predicates ship in Phase 2

A `when: (event) => boolean` field on the trigger declaration. If provided and returns false, the wrapper records `bridge_delivery.status = 'skipped'` with a reason, and does not spawn the user job.

Rationale: `user.created` bursts with internal-test users, `contact.updated` events with changes the handler doesn't care about, replay scenarios — all common, all cheap to filter at bridge time. Cheaper than filtering inside the user job (which would otherwise spin up a run just to return early).

**Reversal cost:** low. Pure codegen — omit the field and handlers filter internally.

### Schema: `bridge_delivery`

```sql
CREATE TABLE bridge_delivery (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES domain_events(id),
  trigger_id        text NOT NULL,                 -- stable, codegen-emitted: "<job_type>#<index>"
  wrapper_run_id    uuid NOT NULL REFERENCES job_run(id),
  user_run_id       uuid REFERENCES job_run(id),   -- null until delivered or if skipped/failed
  status            bridge_delivery_status NOT NULL DEFAULT 'pending',
  skip_reason       text,                          -- populated when status=skipped
  error             jsonb,                         -- populated when status=failed
  tenant_id         text,                          -- mirrors job_run multi-tenancy
  attempted_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  UNIQUE (event_id, trigger_id)                    -- idempotency ledger
);

CREATE TYPE bridge_delivery_status AS ENUM ('pending', 'delivered', 'skipped', 'failed');

CREATE INDEX bridge_delivery_event_idx ON bridge_delivery (event_id);
CREATE INDEX bridge_delivery_status_idx ON bridge_delivery (status) WHERE status IN ('pending', 'failed');
CREATE INDEX bridge_delivery_user_run_idx ON bridge_delivery (user_run_id) WHERE user_run_id IS NOT NULL;
```

Notes:
- `UNIQUE (event_id, trigger_id)` is the idempotency ledger — the outbox can safely replay an event, the drain will attempt to insert a duplicate delivery and fail the constraint, and skip.
- `tenant_id` mirrors the `job_run` multi-tenancy convention (JOB-8 / ADR-022 2026-04-20 revision). Always emitted, always nullable. Multi-tenancy enforced at the `IJobBridge` DI boundary, not via DB constraint.
- No FK from `user_run_id` to `job_run.id` for the case where the orchestrator never created the run (`skipped` due to `when:`).

### The `bridgeRegistry` shape

Generated into `runtime/subsystems/events/generated/bridge.ts` (or `runtime/subsystems/jobs/generated/bridge.ts` — pool-side concern; to be resolved in BRIDGE-3):

```ts
export const bridgeRegistry: BridgeRegistry = {
  'user.created': [
    {
      triggerId: 'send_welcome_email#0',
      jobType: 'send_welcome_email',
      map: (e: EventOfType<'user.created'>) => ({ userId: e.aggregateId }),
      when: undefined,
    },
  ],
  'contact.updated': [
    {
      triggerId: 'sync_contact_to_hubspot#0',
      jobType: 'sync_contact_to_hubspot',
      map: (e) => ({ contactId: e.aggregateId }),
      when: (e) => e.payload.changes.hubspotSynced !== false,
    },
  ],
}
```

Keyed by event type, ordered array per type (preserves declaration order across handlers). `triggerId` is stable across codegens — `<jobType>#<triggerIndex>` — so replays resolve to the same `bridge_delivery` UNIQUE row.

### The framework wrapper handler

Registered automatically by `JobsDomainModule`, lives in `events_inbound | events_change | events_outbound` pools:

```ts
@JobHandler({
  type: '@framework/bridge_delivery',
  pool: 'events_change',        // one per direction; registered 3x
  retryPolicy: { attempts: 3, backoff: 'exponential', base_ms: 1000 },
  // no scope; the delivery is a framework concern
})
class BridgeDeliveryHandler {
  async handle(ctx: JobContext<{ deliveryId: string }>) {
    const delivery = await ctx.step('load_delivery', () =>
      this.deliveryRepo.findById(ctx.input.deliveryId)
    )
    const event = await ctx.step('load_event', () =>
      this.eventRepo.findById(delivery.eventId)
    )
    const registryEntry = bridgeRegistry[event.type]?.find(
      (t) => t.triggerId === delivery.triggerId
    )
    if (!registryEntry) {
      await this.deliveryRepo.markSkipped(delivery.id, 'trigger_unregistered')
      return
    }
    if (registryEntry.when && !registryEntry.when(event)) {
      await this.deliveryRepo.markSkipped(delivery.id, 'when_predicate_false')
      return
    }
    const input = registryEntry.map(event)
    const userRun = await ctx.step('spawn_user_run', () =>
      this.orchestrator.start(registryEntry.jobType, input, {
        parentRunId: ctx.run.id,
        triggerSource: 'event',
        triggerRef: event.id,
        tenantId: event.metadata.tenantId ?? null,
      })
    )
    await this.deliveryRepo.markDelivered(delivery.id, userRun.id)
  }
}
```

Step memoization ensures that a wrapper crashed mid-delivery can replay idempotently: if `spawn_user_run` completed but `markDelivered` didn't, replay skips the spawn and resumes at the mark. The `orchestrator.start()` call is itself idempotent via the user job's own dedupe window if configured.

## Consequences

### Positive

- **Uniform observability.** Bridge fanout appears in the jobs dashboard as runs, using the same visualization primitives as every other run. No separate UI surface.
- **Uniform control plane.** Pool concurrency, pause, throttle, cancel, schedule — all existing job-machinery knobs apply to bridge activity.
- **Typed publish → typed trigger → typed job input.** One `eventRegistry` is the source of truth. `map:` callbacks are typechecked.
- **Idempotency by construction.** `UNIQUE (event_id, trigger_id)` short-circuits replays without application logic.
- **Reserved pools now have purpose.** `events_*` reservation stops being a guard against a phantom future and becomes the operating location of the bridge.
- **Cascade cancel for free.** `parent_run_id` links wrapper to user job; `parent_close_policy` gives per-trigger control.

### Negative

- **2× `job_run` row count per fanout.** Wrappers + user runs. At realistic rates, negligible. At 10k+ events/sec with high fanout, revisit.
- **+1 poll cycle of latency** between event drain and user job start. For non-realtime work (all bridge use cases), negligible. For realtime, bypass the bridge — use an imperative `orchestrator.start()` from the use case.
- **Mental model overhead.** New users see two runs per fanout and ask "what's the wrapper?" Mitigated by naming (`@framework/bridge_delivery`) and dashboard filtering-by-default.
- **Reserved pools carry running code.** Framework-owned code, not user code — but still code that can fail. Mitigation: wrapper handler is small, well-tested, and its failures surface as `bridge_delivery.status = 'failed'` which is ops-visible.

### Neutral

- The outbox drain gains one responsibility: when draining a row, also insert `bridge_delivery` + wrapper `job_run` rows for each matched trigger. This replaces the current "deliver to in-process subscribers" pattern for handlers that do heavy work; in-process subscribers remain valid for cheap projections / cache busts.

## Alternatives considered

### B. Direct spawn (no wrapper run)

Outbox drain calls `orchestrator.start()` directly, writes `bridge_delivery` as an audit row only. One `job_run` per fanout (no wrapper).

**Rejected because:** operational capabilities we want (pause, throttle, retry, cancel, schedule at the bridge layer) would require reimplementing job-like machinery on `bridge_delivery`. Within six months we'd have a parallel claim loop, a parallel retry policy, a parallel concurrency gate — all duplicating what `job_run` already provides. The row-count saving is not worth the parallel machinery.

### C. Dedicated bridge worker process

A separate long-running process that subscribes to `IEventBus` and calls `orchestrator.start()`.

**Rejected because:** it introduces a second worker loop with its own deployment, health-check, and scaling story. The jobs worker already polls; reusing it is free. A separate process only makes sense if bridge work fundamentally differs from job work — it doesn't.

### D. Event-owned triggers (YAML-side)

Declare in `events/user.created.yaml`: `triggers: [send_welcome_email, ...]`.

**Rejected because:** it inverts the ownership. A job's behavior (what it reacts to, how payload maps to input, what conditions apply) splits across two files. The job decorator would no longer be the one place to look for "everything about this job." Future YAML authoring can be added *additively* as decision #1 notes, but it is not the primary surface.

### E. Run-in-the-drain (bridge inline with outbox poller)

Outbox drain worker handles the registry match and calls `orchestrator.start()` directly, without wrapper runs. Similar to B, differs only in code location.

**Rejected because:** same fundamental issue as B. Also: couples the events-subsystem drain poller to the jobs-subsystem orchestrator, adding cross-subsystem imports that should flow the other direction (jobs consumes events registry, not vice versa).

## Phase roadmap

**Phase 2 (this ADR) — ships as BRIDGE-1..N:**
- `bridge_delivery` schema and Drizzle backend.
- `IJobBridge` protocol + framework `BridgeDeliveryHandler`.
- Codegen: `bridgeRegistry` from `@JobHandler.triggers` decorator metadata.
- Build-time validation against `eventRegistry`.
- `when:` predicates and typed `map:` callbacks.
- Multi-tenancy threading (event `metadata.tenantId` → `job_run.tenant_id`).
- Hygen scaffold templates.
- CONSUMER-SETUP + skill documentation.

**Phase 2.5 — deferred, cheap to add later:**
- YAML authoring style (`triggers/*.yaml` or inline in `events/*.yaml`) as a second codegen source.
- `debounce:` field on triggers (collapse N events within window into one delivery).
- Selective dashboard hiding of `@framework/bridge_delivery` runs.

**Phase B (ADR-026) — selective JobEvent broadcast:**
- Certain job lifecycle transitions (e.g., `job_run_completed` for specific handlers) publish as `domain_events`, which can in turn trigger other jobs via this same bridge.
- Does not modify the bridge — only adds a new event-publish call site in `JobEventLogger`.

## Open questions

1. **Wrapper handler registration mechanism.** The framework handler needs to register once per reserved pool (`events_inbound`, `events_change`, `events_outbound`) at module init. Concretely: does `JobsDomainModule.forRoot()` always register it, or does `BridgeModule.forRoot()` exist as a separate opt-in module? **Proposal:** separate `BridgeModule` that imports `JobsDomainModule` + `EventsModule` and wires the framework handler. Opt-in via `@Module({ imports: [BridgeModule.forRoot({ multiTenant })] })`. Keeps jobs and events loosely coupled; the bridge is the *combiner*. To be resolved in BRIDGE-2.

2. **Outbox-drain → bridge_delivery insert atomicity.** The outbox drain must insert `bridge_delivery` + wrapper `job_run` rows in the same transaction it marks the event processed. Otherwise a crash between the two leaves an "event processed, no delivery" state. **Proposal:** single transaction per drained event covers all its matched triggers. To be validated in BRIDGE-4.

3. **Where does `bridgeRegistry` physically live?** `runtime/subsystems/events/generated/bridge.ts` implies events owns it; `runtime/subsystems/jobs/generated/bridge.ts` implies jobs owns it. Neither is quite right — the bridge is the combiner. **Proposal:** `runtime/subsystems/bridge/generated/registry.ts`, with a new skill `.claude/skills/bridge/` that owns the cross-subsystem concern. Avoids making either subsystem import from the other. To be resolved in BRIDGE-3.

4. **Bulk fanout performance.** An event with 50 interested triggers produces 50 `bridge_delivery` + 50 wrapper rows in the drain transaction. For very high fanout, this may dominate drain latency. **Proposal:** measure first; if problematic, batch-insert both tables. Not a Phase 2 blocker.

## Cross-links

- `ADR-022-job-orchestration-domain-model.md` — jobs domain model. Reserved `events_*` pools originate here; `trigger_source='event'` + `trigger_ref=<event_id>` columns on `job_run` already anticipated this ADR.
- `ADR-024-events-domain-formalization.md` — events domain model. The typed registry this ADR builds on.
- `ADR-026-job-observability.md` — selective job lifecycle events; flows back through this bridge.
- `.claude/skills/events/phase-roadmap.md` — Phase 2 entry will be promoted from "deferred" to "shipped" once BRIDGE-1..N land.
- `.claude/skills/jobs/SKILL.md` — reserved pool rules; will gain a cross-link to this ADR's wrapper handler registration.
