# DISPATCH-1 — Declarative dispatch speed on event-arm triggers

**Status:** Draft / Proposed (NOT implemented)
**Date:** 2026-06-15
**Owner:** Doug
**Related:** BULLMQ-2 (`docs/specs/BULLMQ-2.md` — ships the typed `DispatchMode` vocabulary this spec makes declarable); ADR-023 (event→job bridge — this spec REOPENS its rejected alternatives F/G and requires a dated revision); RFC-0005 (`JobDefinitionSchema` + the jobs emitter — the `EventTriggerSchema` arm + the unwired emitter this spec extends); ADR-039 (the schedule-arm cadence); ADR-024 (the `domain_events` outbox)
**Depends on:** BULLMQ-2 (the `DispatchMode` type ships there); RFC-0005 #7 (the jobs emitter wired into `entity.ts`); a dated ADR-023 revision (see [§Required ADR-023 revision](#required-adr-023-revision))

---

## Problem & goal

BULLMQ-2 ships the **typed `DispatchMode` vocabulary** — `'direct' | 'eager' | 'deliberate'` — and the three runtime call shapes that realize it (`IJobOrchestrator.start()`, `IEventFlow.publishAndStart()`, `IEventFlow.publish()`). What it does NOT ship is a way to **declare**, in YAML, which speed a given event-driven job edge should use. Today a `definitions/jobs/*.yaml` `event`-arm trigger compiles to a bridge trigger that is always **deliberate** (durable async fanout via the bridge drain) — there is no knob to say "this particular edge should fire eagerly (recorded + started in one tx)."

The motivating case: **one event fanning out to different jobs with different latency/durability profiles per edge.** `message_landed` might fan out to:

- `index_for_search` — fine to be `deliberate` (async, flood-resistant, can lag).
- `notify_mentioned_user` — wants `eager` (the user is waiting; record the fact AND start the notify in the request path).

Both edges hang off the *same* event. The cadence and durability are properties of *the edge*, not the event. So the dispatch speed belongs on the trigger declaration.

This spec adds an optional **`dispatch: eager | deliberate`** enum to the event-arm of `definitions/jobs/*.yaml` triggers, threads it through the runtime trigger types so the bridge drain branches on it, wires the jobs emitter into the codegen pipeline, and teaches the AST scanner to extract the literal.

> **`'direct'` is deliberately NOT a trigger dispatch value.** `direct` means *you call `IJobOrchestrator.start()` (or `publishAndStart`) yourself* — there is no event, so there is no trigger. A trigger, by definition, fires *in reaction to an event that was published*; modeling `direct` as a trigger is a category error (it would describe "react to an event by pretending no event happened"). The declarable trigger speeds are exactly `eager` and `deliberate`. The full three-mode `DispatchMode` vocabulary is wider than the *trigger* surface on purpose.

## Scope boundary (read this first)

- **In scope (this spec, deferred to implement):** the YAML `dispatch:` enum on the event-arm; the runtime trigger-type threading; wiring the existing-but-unwired jobs emitter; the AST scanner change.
- **Already shipped (BULLMQ-2):** the typed `DispatchMode` vocabulary + the three runtime call shapes. The vocabulary lands in the BULLMQ-2 PR; **only the YAML-declarative emitter is deferred to this spec.**
- **Out of scope:** `direct` as a trigger (category error, above); a generated `JobType` / `JobInputOf<J>` union (a prerequisite for *full* job-arm type-safety, noted below as a dependency-to-come, not built here).

## Design

### 1. YAML surface — `dispatch:` on the event arm

The `event` arm of a job's `triggers[]` (RFC-0005 `EventTriggerSchema`) gains an optional `dispatch` enum:

```yaml
# definitions/jobs/notify_mentioned_user.yaml (sketch)
type: notify_mentioned_user
pool: outbound_notify
triggers:
  - event: message_landed
    dispatch: eager          # NEW — record the fact AND start the job in one tx
arms:
  - kind: realtime
    domain: message
    staging: { table: message_staging }
    read: { mode: webhook, webhook: { ... } }
```

Schema change (`src/schema/job-definition.schema.ts`, `EventTriggerSchema`):

```ts
const EventTriggerSchema = z
  .object({
    event: z
      .string()
      .regex(SNAKE_CASE_RE, "trigger.event must be a snake_case event type"),
    dispatch: z.enum(["eager", "deliberate"]).optional(),   // NEW — default 'deliberate'
  })
  .strict();
```

- **Default `deliberate`** — omitting `dispatch:` keeps today's behavior (bridge async fanout). The knob is purely additive; every existing fixture stays valid.
- **Only on the `event` arm.** The **`schedule` arm carries no `dispatch`** — a scheduled tick is always a recorded fact (it materializes a `domain_event`), so its fanout is inherently `deliberate` through the bridge. Adding `dispatch` to the schedule arm would be meaningless (there is no eager request-path caller for a clock tick). `ScheduleTriggerSchema` is unchanged.
- **`direct` is not in the enum** (category error — see above). The enum is exactly `eager | deliberate`.

### 2. Runtime trigger-type threading

The `dispatch` literal must reach the bridge drain so it can branch. Thread it through the trigger types, all defaulting to `deliberate` when absent:

- **`JobTrigger`** (the runtime trigger shape consumed by the emitter / handler metadata) — add `dispatch?: 'eager' | 'deliberate'`.
- **`ScannedTrigger`** (what the AST scanner extracts from authored `@JobHandler({ triggers })` — `bridge-registry-generator.ts`) — add the `dispatch` field so an authored handler can also declare it (parity with the YAML path).
- **`BridgeTriggerEntry`** (`runtime/subsystems/bridge/bridge.protocol.ts` — the emitted `bridgeRegistry` entry the drain reads) — add `dispatch?: DispatchMode` so the drain has the value at fanout time.

**Drain branch.** `BridgeOutboxDrainHook.processEvent` (`bridge-outbox-drain-hook.ts`) reads `bridgeRegistry[event.type]` and, per matched trigger:

- `dispatch` absent or `'deliberate'` → today's path: insert `bridge_delivery` + a wrapper `job_run` (the deliberate, pull-rate-bounded fanout).
- `dispatch === 'eager'` → the eager path: insert `bridge_delivery(status='delivered')` + start the user `job_run` directly in the per-event tx (no wrapper hop), mirroring the `publishAndStart` Case-B pre-write so a later re-drain dedups on `UNIQUE (event_id, trigger_id)`.

This keeps the ledger as the single source of truth on both branches; `eager` collapses the wrapper hop (one fewer poll cycle) at the cost of doing the `orchestrator.start` inside the drain tx.

### 3. Wire the jobs emitter into `entity.ts` (RFC-0005 #7)

The jobs emitter (`src/cli/shared/job-emission-generator.ts`) **exists and is unit-tested but is not wired into any non-test code path** — it has no `entity.ts` post-step (RFC-0005 #7 is `pending`). DISPATCH-1 requires it to actually run, so this spec carries the RFC-0005 #7 wiring:

- Add the jobs emitter as an `entity new` post-step (the same place the frontend emitter and integration emitters hook in, per ADR-038 / RFC-0001), reading `definitions/jobs/*.yaml` → emitting `@JobHandler` skeletons whose `triggers[]` carry the `dispatch` literal.
- Define generated-skeleton vs AST-scanned-`@JobHandler` coexistence (RFC-0005 OQ-1): the bridge-registry generator scans the flat authored `jobs/` dir; the emitted skeletons must not break that harvest.

(Wiring the emitter is a hard prerequisite — a `dispatch:` enum in YAML is inert until the emitter runs and threads it into the generated handler metadata.)

### 4. AST scanner extracts the `dispatch` literal

The bridge-registry generator's AST scan (`src/cli/shared/bridge-registry-generator.ts`) reads `@JobHandler({ triggers: [{ event, map, when }] })` decorator metadata from authored `.ts`. It must learn to extract the **`dispatch` literal** so an authored handler (not just a YAML-declared job) can set the speed, and so the emitted `bridgeRegistry` entry carries `dispatch` into the drain. The scanner reads a string-literal `dispatch: 'eager' | 'deliberate'`; a non-literal (computed) value is rejected at codegen (the registry must be statically analyzable, mirroring the existing `trigger_id` stability rule).

## Required ADR-023 revision

**This spec reopens ADR-023's rejected alternatives F and G.** ADR-023 explicitly rejected:

- **Alternative F — dual-mode triggers (`@JobHandler.triggers: [{ event, mode: 'bridge' | 'immediate' }]`).** Rejected because "immediate" had ambiguous semantics and *the use case that would drive the decision (durable + <100ms) did not exist yet*.
- **Alternative G — direction-based auto-routing.** Rejected because direction is provenance, not a latency/durability profile.

The bridge skill encodes this as a hard "do not": *"Do not ship dual-mode triggers (`mode: 'bridge' | 'immediate'`) or direction-based auto-routing. Rejected as alternatives F and G — use case doesn't exist; direction is provenance, not latency profile."*

**DISPATCH-1's `dispatch: eager | deliberate` IS a per-trigger dual-mode declaration — exactly the shape F rejected.** It therefore **MUST NOT** ship without a **dated ADR-023 revision note** that overturns the F rejection on the record. The revision must state:

1. **The concrete new use case** that F said did not exist: *the same event fanning out to different jobs with different latency/durability profiles per edge* (e.g. `message_landed` → `notify_mentioned_user` eager + `index_for_search` deliberate). The dispatch speed is a property of the *edge*, not the event — which is precisely why a per-trigger knob (not per-event direction routing, the G shape) is the right surface.
2. **Why F's ambiguity is now resolved.** F's "immediate" was ambiguous (pre-commit sync? post-commit async? bypass or pre-write the ledger?). The BULLMQ-2 `DispatchMode` vocabulary fixes precise semantics: `eager` = `publishAndStart`-equivalent (event + job + ledger in one tx, Case-B dedup), `deliberate` = today's bridge fanout. There is no ambiguity to hide from reviewers; the two speeds map to two named, already-shipped runtime call shapes.
3. **Why G stays rejected.** This is per-*trigger* opt-in, not direction-based auto-routing. Direction remains provenance; the author still declares the speed explicitly per edge. G's objection (refactoring direction silently changes behavior) does not apply.

The bridge skill's "do not ship dual-mode triggers" rule must be updated in the same PR to point at the ADR-023 revision (the rule becomes "dual-mode triggers are the `dispatch:` knob, gated on the ADR-023 revision — see DISPATCH-1," not a blanket prohibition).

> Without the ADR-023 revision, this spec must not land — shipping F's rejected shape silently would violate the bridge skill's "do not re-open ADR-023 decisions without a dated revision note" rule.

## Deferred: generated `JobType` / `JobInputOf<J>` union

Full job-arm type-safety wants a generated `JobType` union and `JobInputOf<J>` mapped type — analogous to events' `EventTypeName` / `EventOfType<T>` — so a trigger's `map:` callback can be typechecked against the *target job's* input shape, and so `IEventFlow.publishAndStart(event, jobType, input, ...)` can type `jobType`/`input` instead of `string`/`unknown` (the protocol JSDoc already flags this as a "post-Phase-2 follow-up that requires generated job typing first").

**This is a prerequisite for FULL job-arm type-safety, not for DISPATCH-1's `dispatch` knob.** The `dispatch` enum is a plain string literal on the trigger — it threads through fine with the existing `jobType: string` shape. DISPATCH-1 ships without the `JobType` union; the union is noted here as the next tightening (it would let the emitter verify that an `eager` edge's target job input matches the event payload `map`). Filed as a follow-up dependency, not a blocker.

## New / changed files

- **`src/schema/job-definition.schema.ts`** (changed) — `dispatch: z.enum(["eager","deliberate"]).optional()` on `EventTriggerSchema`. `ScheduleTriggerSchema` unchanged.
- **`runtime/subsystems/bridge/bridge.protocol.ts`** (changed) — `dispatch?: DispatchMode` on `BridgeTriggerEntry` (and the `JobTrigger` runtime shape).
- **`runtime/subsystems/bridge/bridge-outbox-drain-hook.ts`** (changed) — branch on `trigger.dispatch`: `eager` → in-tx `bridge_delivery(status='delivered')` + direct `orchestrator.start`; `deliberate`/absent → wrapper `job_run` (today's path).
- **`src/cli/shared/bridge-registry-generator.ts`** (changed) — AST scanner extracts the `dispatch` string literal; rejects a non-literal value.
- **`src/cli/shared/job-emission-generator.ts`** (changed) — emit the `dispatch` literal into the generated `@JobHandler({ triggers })`; coexistence with the AST harvest (RFC-0005 OQ-1).
- **`entity.ts`** (changed) — wire the jobs emitter as an `entity new` post-step (RFC-0005 #7).
- **Tests** — schema unit (`dispatch` accepted on event arm, rejected on schedule arm, defaults to deliberate); drain unit (eager vs deliberate branch); AST-scanner unit (literal extracted, computed rejected); `just test-smoke-integration` (the emitted tree tsc-compiles).

## Verification

- **Schema unit** — `dispatch: eager` / `dispatch: deliberate` accepted on an event arm; rejected (stray key) on a schedule arm; absent → defaults to `deliberate`.
- **Drain unit** — a matched `eager` trigger writes `bridge_delivery(status='delivered')` + starts the user run in the per-event tx with no wrapper; a `deliberate` trigger writes a wrapper `job_run`; a re-drain of either dedups on `UNIQUE (event_id, trigger_id)`.
- **AST-scanner unit** — `dispatch: 'eager'` literal extracted into the `bridgeRegistry` entry; a computed `dispatch:` value is a codegen error.
- **Smoke-integration** — per the smoke-integration gate (emitted-output-shape change), `just test-smoke-integration` MUST tsc-compile the emitted tree; unit/integration-emit tests never tsc the emitted output, so this is the load-bearing gate for the emitter change.

## Cross-links

- `docs/specs/BULLMQ-2.md` — ships the `DispatchMode` vocabulary + the three runtime call shapes; the choice rule (proven-actionability → direct/eager; inspect-to-decide → deliberate). DISPATCH-1 makes the `eager | deliberate` subset *declarable* on triggers.
- `docs/adrs/ADR-023-event-to-job-bridge.md` §Alternatives F/G — the rejected dual-mode-trigger / direction-auto-routing decisions this spec overturns (F) and keeps (G), gated on a dated ADR-023 revision.
- `docs/rfcs/RFC-0005-job-definition-kind.md` #7/#8 — the jobs emitter (unwired today) DISPATCH-1 wires; the `EventTriggerSchema` arm it extends; OQ-1 (emitter/AST coexistence).
- `.claude/skills/bridge/SKILL.md` — the "do not ship dual-mode triggers" rule that must be updated (same PR) to point at the ADR-023 revision.
- `runtime/subsystems/bridge/bridge.protocol.ts` — `BridgeTriggerEntry` (gains `dispatch`), `IEventFlow.publishAndStart` (the `eager` runtime shape; the `jobType: string` / `input: unknown` the deferred `JobType` union would tighten).
