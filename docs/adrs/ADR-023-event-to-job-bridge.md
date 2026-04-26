# ADR-023 — Event-to-Job Bridge

**Status:** Shipped
**Date:** 2026-04-21 (original draft), revised 2026-04-21 (review pass), shipped 2026-04-22 via BRIDGE-1..9 (PRs #168, #169, #170, #171, #172, #174, #175, #176, BRIDGE-9)
**Owner:** Doug
**Related:** ADR-022 (Job Orchestration Domain Model), ADR-024 (Events Domain Formalization), ADR-008 (Subsystem Architecture)
**Depends on:** ADR-024 Phase 1 (shipped via EVT-1..EVT-8) — typed event registry, `TypedEventBus`, direction-routed outbox
**Unblocks:** ADR-026 (JobEvent Observability — selective job lifecycle → events broadcast)

## 2026-04-26 Revision Note — Audit-tier guard (AUDIT-4)

The bridge outbox drain hook (`runtime/subsystems/bridge/bridge-outbox-drain-hook.ts`) gains a top-of-`processEvent` guard for `tier:audit` events. This is a **defense-in-depth** addition; the codegen-side validator from AUDIT-2 (which hard-errors on a job declaring `triggers: [<audit_event>]`) remains the **primary** enforcement.

Behaviour:

- If `event.metadata.tier === 'audit'`, the hook returns `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 }` immediately — no `bridge_delivery` row is written, no wrapper `job_run` is spawned.
- A WARN fires once per `(event_type, process)` via a private `Set<string>` (`warnedAuditTypes`). Finer-grained than the once-per-process `warnedNullDirection` flag; drift in a specific event type surfaces without flooding logs across many types.
- `BridgeOutboxDrainResult` gains `auditBlocked: number`. `0` on every non-audit return path; `1` when the guard fires. Per-event observability data that rides on the existing return shape — no new protocol method, no new state on the hook.

Why a runtime guard at all when codegen already errors: catches drift the codegen path cannot — out-of-band `bridge_trigger` inserts (manual ops, recovery scripts, faulty migrations) and version skew during rolling deploys (old generator, new bus). Reaching the guard is by definition unexpected; the WARN is the operator-facing surface and `auditBlocked` is the machine-readable surface.

No `IObservability` read for audit-blocks ships in this PR. Two clean follow-up paths exist if production needs aggregate visibility — `getBridgeAuditBlocks(windowHours)` on the bridge port + observability composer, or self-published `bridge.audit_blocked` audit-tier events surfaced by the AUDIT-5 viewer. File AUDIT-6 if a real consumer asks.

Spec: `ai-docs/specs/issue-242/plan.md` §AUDIT-4. Sequenced after AUDIT-3 (the bus stamps `metadata.tier` so the guard has something to read).

## 2026-04-21 Revision Notes

This ADR was reviewed on 2026-04-21 against the draft shipped in PR #9cca553. Refinements below are **additions**, not rewrites — every original decision stands.

Changes incorporated:

1. **New Decision 7** — Developer-facing facade `IEventFlow` with two verbs (`publish`, `publishAndStart`). Closes the authoring-consistency gap: without it, Tier 2 code looks like uncoupled `publish()` + `orchestrator.start()` calls and Tier 3 code looks like decorator metadata. The facade makes the tiers grep-friendly and review-visible.
2. **New section** — *Three tiers of event-driven work* (subscribe / direct invoke / bridge). Clarifies that the bridge is one of three sanctioned patterns, not the only answer. Includes decision tree.
3. **Decision 2 update** — Concrete latency guardrails added: typed JSDoc on `triggers:` field, CONSUMER-SETUP "When NOT to use the bridge" section, hop-count table.
4. **Decision 1 commitment** — Reverse-lookup CLI `codegen events consumers <type>` indexes all three tiers. Shipped in Phase 2.
5. **New section** — *`publishAndStart` + existing `triggers:` collision*. The facade pre-writes a `bridge_delivery` row so the drain's later UNIQUE constraint dedups the bridge-side spawn. Exactly one execution per (event, trigger) pair.
6. **Open Q1 + Q3 resolved** — Locked: new `runtime/subsystems/bridge/` subsystem with its own `BridgeModule.forRoot()`. Registry lives at `runtime/subsystems/bridge/generated/registry.ts`.
7. **Open Q2 resolved** — Drain atomicity is one transaction per event, within per-event processing (not one tx per batch).
8. **New section** — *Pool alignment guidance*. Two pool layers (reserved `events_*` wrapper pools + user job pools); pool-per-class-of-work, not per-event-type.
9. **New section** — *Events are facts, jobs are work*. Short primer for new readers; resolves the common "I publish an event, what runs?" confusion.
10. **Added to Consequences** — Trigger rename/removal, event payload schema evolution, multi-tenancy null-tenantId error path, ordering guarantees.
11. **Moved out** — The `BridgeDeliveryHandler` pseudocode (decision 2) moved to the BRIDGE-5 spec; this ADR keeps the flow diagram only.

Phase 2 PR stack is spelled out in `docs/specs/BRIDGE-PHASE-2-PLAN.md`.

---

## Context

ADR-024 established events as immutable facts published through a transactional outbox (`domain_events`), with pool-filtered drain and three directions (`inbound | change | outbound`). ADR-022 established jobs as durable stateful work (`job_run`) with hierarchy, scope, retry policy, and pool-based concurrency. The two subsystems meet at a specific seam: **some events should trigger jobs**.

Today, that seam is hand-written: a consumer subscribes via `IEventBus.subscribe()` and calls `IJobOrchestrator.start()` from inside the subscriber. This works, but:

1. **Subscribers that do real work block the outbox drain.** The events skill explicitly warns against this ("subscribers should enqueue a job, not do heavy work inline"). Without a formalized bridge, every consumer re-implements the same "thin subscriber calls orchestrator" pattern, incorrectly.
2. **There is no idempotency ledger.** If the outbox replays an event (drain worker crash, at-least-once delivery), a naive subscriber spawns duplicate `job_run` rows. Every consumer needs to implement their own dedupe.
3. **There is no typed binding.** The subscriber writes `ev.payload as { accountId: string }` — the registry knows the payload shape but the subscriber doesn't consult it.
4. **There is no control plane.** An operator who wants to pause event-driven fanout (during a migration, during an incident) has no single knob. They either stop the outbox (kills everything including in-process subscribers) or set flags in N services.
5. **The reserved `events_inbound | events_change | events_outbound` pools exist but have no behavior.** ADR-022 reserved them against user handlers "for the bridge." Until the bridge lands, the reservation is a guard with no occupant.
6. **There is no consistent authoring surface.** Different consumers express functionally identical flows in radically different shapes — some with imperative calls, some with ad-hoc subscribers, some with hand-rolled dedup tables. Review-time, nothing signals "this is a durable fanout" vs "this is a request-path call."

The bridge closes that seam. It is the single, formalized, typed, observable path from "an event was published" to "a job was started in response." It is **owned by neither the events subsystem nor the jobs subsystem** — it's a narrow layer between them.

## Primer: events are facts, jobs are work

Before the decisions, name the distinction this ADR is built on.

**An event is a fact.** Past tense. Immutable. Just data:

```ts
type UserSignedUp = {
  type: 'user.signup'
  payload: { userId: string, email: string }
}
```

Publishing an event is like writing a diary entry. It has no behavior on its own.

**A job is a unit of work.** A named handler class with an execute method:

```ts
@JobHandler({ type: 'send_welcome_email', pool: 'outbound_email' })
class SendWelcomeEmailJob {
  async handle(ctx: JobContext<{ userId: string }>) {
    // actually sends the email
  }
}
```

When you "run a job" you instantiate its handler and call `handle(ctx)`.

The bridge is the map: **when event X occurs, run jobs J₁..Jₙ.** You always start a specifically named job. You never "run an event."

## Three tiers of event-driven work

The bridge is not the only sanctioned way to react to events. There are three tiers, each with a different durability/latency profile. Authors pick by use case.

| Tier | Mechanism | Durability | Latency | Use for |
|---|---|---|---|---|
| **1. Subscribe** | `IEventBus.subscribe()` in-process | None (at-most-once) | ~ms | metrics, cache busts, logs |
| **2. Direct invoke** | `events.publishAndStart(...)` (facade, Decision 7) | Yes, via caller tx | 1 worker claim poll | request-path work needing durability |
| **3. Bridge** | `@JobHandler({ triggers: [...] })` | Yes, via outbox+ledger | 2–3 poll cycles | durable async fanout |

### Decision tree

```
You want work to happen when event X is published.

Does the user/caller need to wait for it?
├── YES → Tier 2: events.publishAndStart(X, jobType, input)
│
└── NO → Can you tolerate occasional loss (cheap/recoverable)?
         ├── YES → Tier 1: IEventBus.subscribe('X', handler)
         │
         └── NO  → Tier 3: @JobHandler({ triggers: [{ event: 'X', ... }] })
```

### Visibility of all three tiers

A single CLI command, `codegen events consumers <event_type>`, scans all three:

- `bridgeRegistry` entries (Tier 3)
- Grep for `publishAndStart(X, ...)` call sites (Tier 2 — AST scan of the facade method)
- Declared `IEventBus.subscribe('X', ...)` handlers (Tier 1)

Output is a single fanout report per event type. This is how reverse discoverability works — no need for an event-owned YAML surface. **Committed to Phase 2 scope.**

## Decision

### Architectural spine vs. authoring surface

Split the bridge into two layers with different change cost:

| Layer | What lives here | Cost to change after ship |
|---|---|---|
| **Spine** (runtime contract) | `IJobBridge` + `IEventFlow` protocols, `bridge_delivery` table, `bridgeRegistry` shape, wrapper-run execution model | High — schema migration or protocol bump |
| **Authoring surface** | How users declare triggers: decorator form, optional YAML form, `map:` / `when:` fields; the facade method names | Low — pure codegen and service-layer naming, no runtime impact |

The spine is opinionated and minimal. The authoring surface is free to grow; new authoring styles compile down to the same `bridgeRegistry` without touching the runtime.

This matches the core-contract + extensions pattern from CLAUDE.md: the spine guarantees portability and observability; authoring styles layer on top additively.

### Seven locked decisions

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

**Reverse discoverability** — the concern that job-owned triggers make "what listens to event X?" require a grep — is resolved by the `codegen events consumers <type>` CLI (see *Three tiers* above).

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

(`BridgeDeliveryHandler` implementation lives in `docs/specs/BRIDGE-5.md`.)

Rationale: reusing `job_run` machinery (pool concurrency, retry, cancellation cascade, memoization, observability) for bridge deliveries is strictly cheaper than building parallel versions of all those features for `bridge_delivery`. Every operational capability the jobs subsystem already has applies to bridge fanout for free:

- **Pause fanout globally**: `jobs.pools.events_change.concurrency = 0` holds wrappers in `pending`. Flip back on, they drain.
- **Throttle fanout**: pool concurrency limit.
- **Retry bridge delivery on infra blip**: wrapper's own retry policy.
- **Cancel fanout tree**: cancel the wrapper → cascade via `parent_run_id` + `parent_close_policy`.
- **Delay / debounce**: wrapper has `run_at`; schedule it.
- **Observability**: wrappers show up in the jobs dashboard like any other run. Every Airflow/Temporal-style view gets bridge activity for free.

**Latency cost.** 2× `job_run` rows per fanout (wrapper + user job), and **2–3 poll cycles** of latency from publish to user-job execution:

| Hop | Stage | Time (typical) |
|---|---|---|
| 1 | outbox drain poll | 100–1000ms |
| 2 | wrapper claim poll | 100–1000ms |
| 3 | user job claim poll | 100–1000ms |
| — | **Total publish → user handle()** | **~300ms – 3s** |

At realistic event rates (100s–1000s/sec), this is not a concern. At 10k+/sec with high fanout, revisit.

**Latency guardrails** (new in revision):

- JSDoc on `@JobHandler.triggers`: *"Adds ~{poll_interval × 2–3} of latency. For sub-second request-path work, use `events.publishAndStart()` instead."*
- CONSUMER-SETUP section: **"When NOT to use the bridge"** — names the cutoff (>1s latency tolerable, durability required, observability in dashboard wanted). Points to `publishAndStart` for sub-second needs.

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
- `skipped` — intentional no-op (`when:` returned false, or pre-emptive facade-side delivery write dedup'd a bridge-side spawn).
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

#### 7. Developer-facing facade: `IEventFlow` service with two verbs

Two imperative call shapes — `publish` and `publishAndStart` — exposed via an injectable `IEventFlow` token. All request-path and fanout publishing goes through this facade, not through `IEventBus` directly. Subscribers (Tier 1) remain declarative (`@OnEvent` decorator) and bypass the facade.

```ts
export interface IEventFlow {
  /**
   * Tier 3 + Tier 1 — plain publish.
   * Writes to outbox; bridge triggers fire async (via @JobHandler.triggers);
   * in-process @OnEvent subscribers fire in-call.
   * Returns when the outbox row is committed.
   */
  publish<T extends EventType>(
    event: TypedEvent<T>
  ): Promise<void>

  /**
   * Tier 2 + Tier 3 + Tier 1 — publish + eagerly start a specific named job.
   * Writes to outbox; ALSO inserts a job_run for `jobType` synchronously
   * via orchestrator.start(). Bridge triggers and @OnEvent subscribers
   * fire as normal for the event. Returns the eagerly-started run's id.
   *
   * Use when the caller needs the job enqueued before returning to the
   * user (request-path, within-transaction durability). If the same job
   * has a declared trigger for this event, the facade pre-writes a
   * bridge_delivery(status=delivered) row to dedup the later bridge spawn.
   */
  publishAndStart<T extends EventType, J extends JobType>(
    event: TypedEvent<T>,
    jobType: J,
    input: JobInputOf<J>,
    opts?: {
      parentRunId?: string
      tenantId?: string | null
    }
  ): Promise<{ runId: string }>
}
```

Rationale: without the facade, Tier 2 code looks like uncoupled `eventBus.publish()` + `orchestrator.start()` calls — there's no grep that distinguishes "these are semantically coupled" from "these are independent operations." Two developers producing functionally identical flows write visibly different code. The facade forces consistency:

- **Review-visible**: `grep publishAndStart` finds every Tier 2 call site; `grep publish` finds every Tier 3 call site.
- **Consistent shape across teams**: same verb, same argument order, same error handling.
- **Grep-friendly for the fanout CLI**: `codegen events consumers <type>` can AST-scan `publishAndStart` calls alongside bridge triggers and subscribers.
- **Explicit about dedup**: `publishAndStart` handles the "job has both a declared trigger and an eager-start call site" case in one place (see below).
- **Matches pattern-stack Python precedent**: `backend-patterns` exposes intent-named verbs over raw primitives; this mirrors that shape.

Under the hood the facade is thin: `publish` delegates to `IEventBus.publish`; `publishAndStart` delegates to `IEventBus.publish` + `IJobOrchestrator.start` + (if relevant) an idempotent pre-write of `bridge_delivery`.

**Reversal cost:** low. The facade is a pure service layer over existing primitives. Removing it just reverts authors to calling the underlying services directly.

### `publishAndStart` + existing `triggers:` collision

The intersection case needs explicit handling:

- **Case A** — the job has NO `triggers:` entry for this event. `publishAndStart` is the only path that starts this job for this event. Bridge drain scans registry, finds no match, never spawns. **No double-run possible.** Common case.
- **Case B** — the job HAS a `triggers:` entry AND a caller uses `publishAndStart` with the same (event, job) pair. Without intervention, both paths would spawn a `job_run`.

For Case B, the facade **pre-writes a `bridge_delivery` row** before (or as part of) the eager `orchestrator.start()` call:

```ts
// Inside publishAndStart, for Case B:
await tx.insert(bridge_delivery).values({
  event_id,
  trigger_id: `${jobType}#${triggerIndex}`,
  wrapper_run_id: null,                // facade never writes a wrapper
  user_run_id: eagerRunId,
  status: 'delivered',                 // already done, bridge should skip
  // ...
})
```

When the outbox drain later processes the event and attempts to insert its own `bridge_delivery` row for the same `(event_id, trigger_id)`, the `UNIQUE` constraint fails → drain catches it → skips that trigger → other triggers for the same event still fire normally.

**Result:** exactly one execution per (event, trigger) pair, regardless of invocation path. The ledger is the single source of truth.

The `trigger_id` resolution requires the facade to consult `bridgeRegistry` at call time — adding a registry lookup per `publishAndStart` call. At facade-level this is a constant-time Map access against the in-memory registry; negligible cost.

### Pool alignment guidance

Pools are the unit of concurrency control. Jobs in the same pool compete for slots; head-of-line blocking between dissimilar work classes is the classic failure mode. Bridge-driven fanout spans **two pool layers**:

```
publish(user.signup)
   │
   ▼
┌──────────────────────┐
│ wrapper job_run      │ ← Pool A: events_change (reserved, framework-owned)
│ @framework/bridge_   │   — one per event direction, cheap wrappers
│  delivery handler    │
└──────────┬───────────┘
           │
           │ wrapper calls orchestrator.start(userJob)
           ▼
┌──────────────────────┐
│ user job_run         │ ← Pool B: declared by @JobHandler.pool
│ SendWelcomeEmailJob  │   — contention happens HERE
│   pool: outbound_email│
└──────────────────────┘
```

**Pool A (reserved `events_*`):** bridge wrappers only. Cheap (~1ms per wrapper run: registry lookup, `when:` evaluation, `orchestrator.start`, ledger update). Run at high concurrency (e.g., 32). Not usually a bottleneck.

**Pool B (user pools):** actual work, real contention. This is where author pool choice matters.

**Rule of thumb.** Pool-per-class-of-work, not per-event-type. One event can fan out into many different user pools:

```
user.signup  (events_change wrapper pool)
   ├─→ SendWelcomeEmailJob      → outbound_email
   ├─→ ProvisionWorkspaceJob     → internal
   ├─→ EmitAnalyticsJob          → outbound_analytics
   └─→ SyncContactToHubspotJob   → external_crm
```

Each user pool answers one question: *what scarce resource am I protecting behind this queue?* Typical pool set:

| Pool | Scarce resource |
|---|---|
| `outbound_email` | SMTP / Mailgun throughput |
| `outbound_analytics` | Segment batch-send efficiency |
| `external_crm` | HubSpot / SFDC API rate limits |
| `external_payments` | Stripe rate limit, high-stakes retries |
| `internal` | general-purpose, no external dependency |
| `background_reports` | low-priority, slow, shouldn't starve user-facing work |

**4–8 pools** for a medium app. Too few → head-of-line blocking. Too many → operational toil.

The reserved `events_*` pools don't count toward that budget — they're fixed by the framework.

**Ordering guarantee** (new in revision): reserved-pool concurrency > 1 means no implicit ordering between sequential events for the same user pool. If a consumer needs "A before B" ordering for events on the same aggregate, set `jobs.pools.events_<direction>.concurrency = 1` (serializes wrappers) or `jobs.pools.<user_pool>.concurrency = 1` (serializes user jobs). Default configuration gives parallelism, not ordering.

### Schema: `bridge_delivery`

```sql
CREATE TABLE bridge_delivery (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES domain_events(id),
  trigger_id        text NOT NULL,                 -- stable, codegen-emitted: "<job_type>#<index>"
  wrapper_run_id    uuid REFERENCES job_run(id),   -- nullable: null when facade pre-wrote as 'delivered'
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
- `UNIQUE (event_id, trigger_id)` is the idempotency ledger — the outbox can safely replay an event, the drain will attempt to insert a duplicate delivery and fail the constraint, and skip. Also dedups facade-eager vs bridge-drain for the same (event, trigger) pair (see Decision 7 collision section).
- `wrapper_run_id` is nullable to accommodate facade-eager delivery writes that have no wrapper (the facade started the user job directly, no wrapper needed). The bridge-drain path always populates it.
- `tenant_id` mirrors the `job_run` multi-tenancy convention (JOB-8 / ADR-022 2026-04-20 revision). Always emitted, always nullable. Multi-tenancy enforced at the `IJobBridge` / `IEventFlow` DI boundary, not via DB constraint.

### The `bridgeRegistry` shape

Generated into **`runtime/subsystems/bridge/generated/registry.ts`** (resolves original Open Q3 — bridge subsystem owns it, not events and not jobs):

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

### `BridgeModule` and subsystem boundaries

**2026-04-22 — clarification:** the framework handler is registered ONCE via `@JobHandler('@framework/bridge_delivery', ...)`; the three reserved pools are claimed by three workers, each routing claimed rows to the same handler class via `JOB_HANDLER_REGISTRY` lookup. What `BridgeModule` actually does is provide the handler class as a Nest provider (so DI resolves its constructor deps) AND fail-fast at boot if `JobWorkerModule` isn't polling all three reserved pools (`BRIDGE_RESERVED_POOLS` const + `BridgeReservedPoolsNotPolledError`). Per-direction routing happens via `job_run.pool='events_<direction>'` set by `BridgeOutboxDrainHook` (BRIDGE-4). The reserved-pool validator exemption (BRIDGE-5) lets the framework handler legitimately target a reserved pool.

New subsystem at `runtime/subsystems/bridge/`. Its `BridgeModule.forRoot({ backend, multiTenant })` provides the framework `BridgeDeliveryHandler` as a Nest provider (auto-registered in `JOB_HANDLER_REGISTRY` by the `@JobHandler` decorator at module load), wires the `IJobBridge` and `IEventFlow` tokens, runs the boot-time pool check described above, and exposes everything globally.

This is the *combiner*: neither events nor jobs subsystems know about the bridge. The bridge imports from both.

Consumer wiring:

```ts
@Module({
  imports: [
    EventsModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    JobsDomainModule.forRoot({ /* ... */ }),
    BridgeModule.forRoot({ multiTenant: false }),   // ← add this line
  ],
})
class AppModule {}
```

**`BridgeModule` must be imported after `EventsModule` and `JobsDomainModule`** — the framework handler registration consults both subsystems' DI tokens. Documented in CONSUMER-SETUP.

### Outbox drain atomicity

The outbox drain inserts one `bridge_delivery` row + one wrapper `job_run` row **per matched trigger, all inside a single per-event transaction**, along with marking the event `processed_at`. A crash inside this transaction leaves the event unprocessed for re-claim; the `UNIQUE(event_id, trigger_id)` constraint dedups the eventual retry.

The drain processes events in batch (claim N rows at once via `FOR UPDATE SKIP LOCKED`) but each event's processing runs in its own transaction inside the batch loop. This prevents a single bad trigger from failing the whole batch.

(Resolves original Open Q2.)

## Consequences

### Positive

- **Uniform observability.** Bridge fanout appears in the jobs dashboard as runs, using the same visualization primitives as every other run. No separate UI surface.
- **Uniform control plane.** Pool concurrency, pause, throttle, cancel, schedule — all existing job-machinery knobs apply to bridge activity.
- **Typed publish → typed trigger → typed job input.** One `eventRegistry` is the source of truth. `map:` callbacks are typechecked.
- **Idempotency by construction.** `UNIQUE (event_id, trigger_id)` short-circuits replays AND dedups facade-eager vs bridge-drain collision.
- **Reserved pools now have purpose.** `events_*` reservation stops being a guard against a phantom future and becomes the operating location of the bridge.
- **Cascade cancel for free.** `parent_run_id` links wrapper to user job; `parent_close_policy` gives per-trigger control.
- **Three-tier consistency.** The facade + CLI make the authoring model explicit: Tier 1, 2, 3 each have a named call shape and appear in the same fanout report.
- **Grep-reviewable fanout.** `publishAndStart` call sites are greppable; `@JobHandler.triggers` decorators are greppable; `@OnEvent` subscribers are greppable. Reviewers can audit fanout without reading every use case.

### Negative

- **2× `job_run` row count per fanout.** Wrappers + user runs. At realistic rates, negligible. At 10k+ events/sec with high fanout, revisit.
- **2–3 poll cycles of latency** between event publish and user job start via the bridge. For non-realtime work, negligible. For realtime, use `publishAndStart` (Tier 2).
- **Mental model overhead.** New users see two runs per bridge fanout and ask "what's the wrapper?" Mitigated by naming (`@framework/bridge_delivery`) and dashboard filtering-by-default.
- **Reserved pools carry running code.** Framework-owned code, not user code — but still code that can fail. Mitigation: wrapper handler is small, well-tested, and its failures surface as `bridge_delivery.status = 'failed'` which is ops-visible.
- **Facade indirection.** Authors no longer call `IEventBus.publish` directly — they go through `IEventFlow.publish`. Small cognitive overhead; documented in CONSUMER-SETUP. The trade is enforced by convention, not compiler; a determined author can still reach for `IEventBus` and lose the consistency property.

### Neutral / edge cases (added in revision)

- **Trigger rename or removal.** Renaming `send_welcome_email` → `send_user_welcome` changes the `triggerId` (`send_welcome_email#0` → `send_user_welcome#0`). In-flight `bridge_delivery` rows for the old name become orphaned but benign — they're audit-only after the run completed; if still `pending`, the bridge-delivery handler no longer finds a registry entry and marks them `skipped` with `skip_reason='trigger_unregistered'`. No auto-migration. Documented in CONSUMER-SETUP.
- **Event payload schema evolution.** If an event's payload shape changes in a non-backward-compat way, replayed `bridge_delivery` rows reference events with the old shape but `map:` code expects the new shape. Step memoization on the wrapper handler protects the already-completed `spawn_user_run` step; only the never-yet-run replays hit `map:`, and those will surface as typecheck errors (caught at codegen) or runtime errors (wrapper marked `failed`). **Rule**: breaking schema changes require a coordinated trigger-map migration in the same PR. Documented in `.claude/skills/bridge/`.
- **Multi-tenancy null-tenantId.** When `BridgeModule` is configured with `multiTenant: true` and an event's `metadata.tenantId` is null, the wrapper handler throws `MissingTenantIdError` (same error shape as jobs / sync / events subsystems) and the delivery transitions to `failed`. The eager `publishAndStart` path enforces the same at its entry (before writing the `bridge_delivery` row) — mirrors JOB-8 / SYNC-6 precedent.
- **Ordering guarantee.** Reserved-pool concurrency > 1 means sequential events for the same aggregate can have their user jobs run out of order. Consumers needing strict ordering must set pool concurrency to 1. Documented in CONSUMER-SETUP.

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

**Rejected because:** same fundamental issue as B. Also: couples the events-subsystem drain poller to the jobs-subsystem orchestrator, adding cross-subsystem imports that should flow through the bridge subsystem instead.

### F. Dual-mode triggers (`@JobHandler.triggers: [{ event, mode: 'bridge' | 'immediate' }]`)

Considered during the 2026-04-21 review. The `triggers:` declaration would carry a `mode:` field selecting sync vs async execution at the same declaration site.

**Rejected because:** "immediate" has ambiguous semantics (pre-commit sync? post-commit async? bypass or pre-write the ledger?), and the use case that would drive the decision (durable + <100ms) doesn't exist yet. Additionally, mixing execution modes on the same authoring surface hides meaningful behavioral differences from reviewers. Direct invoke (Tier 2 via `publishAndStart`) already handles the sub-second case; keeping the two paths at different call sites makes the intent visible. Revisit in Phase 3 if evidence materializes.

### G. Direction-based auto-routing (events pick their own tier)

Considered during the 2026-04-21 review. Map event direction (`inbound | change | outbound`) to execution mode automatically — e.g., `change` → direct invoke, `inbound/outbound` → bridge.

**Rejected because:** direction describes *where an event comes from / where it's going*, not the durability/latency profile of downstream reactions. The same event (`order.placed`) has three triggers in this ADR's examples that each want different profiles. Auto-routing by direction would make execution semantics implicit and refactoring event direction would silently change every trigger's behavior.

## Phase roadmap

**Phase 2 (this ADR) — ships as BRIDGE-1..N:**

See `docs/specs/BRIDGE-PHASE-2-PLAN.md` for the PR stack and dependency graph.

Summary:
- `bridge_delivery` schema + Drizzle backend
- `IJobBridge` + `IEventFlow` protocols
- New `runtime/subsystems/bridge/` subsystem + `BridgeModule.forRoot()`
- Framework `BridgeDeliveryHandler` + outbox drain integration
- Codegen: `bridgeRegistry` from `@JobHandler.triggers` decorator metadata
- Build-time validation against `eventRegistry`
- `when:` predicates and typed `map:` callbacks
- `EventFlowService` facade implementation (both verbs)
- Multi-tenancy threading (event `metadata.tenantId` → `job_run.tenant_id`)
- Fanout CLI: `codegen events consumers <type>`
- Hygen scaffold templates
- CONSUMER-SETUP + `.claude/skills/bridge/` documentation

**Phase 2.5 — deferred, cheap to add later:**
- YAML authoring style (`triggers/*.yaml` or inline in `events/*.yaml`) as a second codegen source.
- `debounce:` field on triggers (collapse N events within window into one delivery).
- Selective dashboard hiding of `@framework/bridge_delivery` runs.

**Phase B (ADR-026) — selective JobEvent broadcast:**
- Certain job lifecycle transitions (e.g., `job_run_completed` for specific handlers) publish as `domain_events`, which can in turn trigger other jobs via this same bridge.
- Does not modify the bridge — only adds a new event-publish call site in `JobEventLogger`.

## Resolved questions

1. **Wrapper handler registration** — *resolved* (revised 2026-04-22): the framework `BridgeDeliveryHandler` is registered ONCE via the `@JobHandler('@framework/bridge_delivery', ...)` decorator (auto-registered in `JOB_HANDLER_REGISTRY` at module load). Per-direction routing happens via `job_run.pool='events_<direction>'` set by `BridgeOutboxDrainHook`; workers polling each of the three reserved pools (`events_inbound`, `events_change`, `events_outbound`) claim wrappers from their own pool and dispatch to the same handler class. `BridgeModule` ships `BRIDGE_RESERVED_POOLS` for consumers to spread into `JobWorkerModule.forRoot({ pools })` and runs a boot-time check that throws `BridgeReservedPoolsNotPolledError` if any reserved pool isn't polled. See *`BridgeModule` and subsystem boundaries* above.
2. **Outbox-drain atomicity** — *resolved*: per-event transaction inside the drain's batch loop; marks `processed_at` + inserts `bridge_delivery` + wrapper `job_run` together. See *Outbox drain atomicity*.
3. **Where `bridgeRegistry` lives** — *resolved*: `runtime/subsystems/bridge/generated/registry.ts`, owned by the new bridge subsystem. See *The `bridgeRegistry` shape* above.
4. **Bulk fanout performance** — *unresolved; not a Phase 2 blocker*: an event with 50 interested triggers produces 50 `bridge_delivery` + 50 wrapper rows in the drain transaction. Measure first; if problematic, batch-insert both tables.
5. **`publishAndStart` + trigger collision** — *resolved*: facade pre-writes `bridge_delivery(status=delivered)` so drain's later insert hits UNIQUE and skips. See *`publishAndStart` + existing `triggers:` collision*.

## Cross-links

- `ADR-022-job-orchestration-domain-model.md` — jobs domain model. Reserved `events_*` pools originate here; `trigger_source='event'` + `trigger_ref=<event_id>` columns on `job_run` already anticipated this ADR.
- `ADR-024-events-domain-formalization.md` — events domain model. The typed registry this ADR builds on.
- `ADR-026-job-observability.md` — selective job lifecycle events; flows back through this bridge.
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — PR stack and orchestration plan for the implementation.
- `.claude/skills/events/phase-roadmap.md` — Phase 2 entry will be promoted from "deferred" to "shipped" once BRIDGE-1..N land.
- `.claude/skills/jobs/SKILL.md` — reserved pool rules; will gain a cross-link to this ADR's wrapper handler registration.
- `.claude/skills/bridge/SKILL.md` — new skill created in BRIDGE-10.
