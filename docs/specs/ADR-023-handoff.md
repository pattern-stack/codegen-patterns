# ADR-023 Handoff — Event-to-Job Bridge

**Status:** draft ADR written, awaiting second-opinion review before BRIDGE-1..N specs are cut.
**Primary artifact:** `docs/adrs/ADR-023-event-to-job-bridge.md`
**Related context:** ADR-022 (jobs), ADR-024 (events), `.claude/skills/events/phase-roadmap.md` (Phase 2 entry).

## What this is

The bridge connects two already-shipped subsystems: the events outbox (ADR-024, EVT-1..8) and the jobs orchestration domain (ADR-022, JOB-1..8). Today that seam is hand-written — consumers subscribe to `IEventBus` and call `IJobOrchestrator.start()` from inside the subscriber. The ADR formalizes it.

The reserved `events_inbound | events_change | events_outbound` pools in the jobs subsystem have existed since ADR-022 as placeholders specifically for this bridge. Nothing runs in them today.

## The design in one paragraph

Triggers are declared on the job (`@JobHandler({ triggers: [{ event, map, when }] })`). Codegen scans handlers and emits a `bridgeRegistry` keyed by event type. When the outbox drain claims a `domain_events` row, it inserts one `bridge_delivery` audit row + one `job_run` row (`type=@framework/bridge_delivery`, `pool=events_<direction>`) per matched trigger. The wrapper `job_run` is claimed by the ordinary job worker; the framework's `BridgeDeliveryHandler` runs it, evaluates `when:`, applies `map:`, and calls `orchestrator.start(userJob, mapped, { parentRunId: self })`. The user job runs in its declared pool, linked to the wrapper as parent so cascade cancel works.

## Six locked decisions (all revisitable; costs noted)

| # | Decision | Reversal cost |
|---|---|---|
| 1 | Job-owned triggers via decorator | Low (codegen-only) |
| 2 | Bridge IS the jobs worker on reserved pools (wrapper `job_run` per delivery) | **Medium — this is the one I'm least certain on** |
| 3 | Typed TS `map:` / `when:` callbacks (not YAML DSL) | Low |
| 4 | `bridge_delivery.status = pending/delivered/skipped/failed`, no auto-retry | Low |
| 5 | Build-time validation against `eventRegistry` | None |
| 6 | `when:` predicates ship in Phase 2 | Low |

## Where I'd most want pushback

### Decision 2 — wrapper run vs. direct spawn

Between two variants I considered:

- **(a) Wrapper runs in reserved pools** (chosen): outbox drain inserts `bridge_delivery` + wrapper `job_run` in reserved pool. Wrapper handler calls `orchestrator.start()` for the user job.
- **(b) Direct spawn**: outbox drain calls `orchestrator.start()` inline, writes `bridge_delivery` as audit-only. One `job_run` per fanout instead of two.

I chose (a) because every operational capability we want (pause fanout, throttle, retry, cancel, schedule, observability) already exists on `job_run` and would need to be reimplemented on `bridge_delivery` in (b). User agreed with (a) on the "control-plane separation" argument.

Cost of (a): 2× row count per fanout; +1 poll cycle of latency. At realistic rates (100s–1000s/sec), fine. At 10k+/sec with high fanout, revisit.

**Things an outside reviewer should stress-test:**
- Is the 2× row count actually free at our target scale, or am I hand-waving? Back-of-envelope for `user.created` with typical fanout.
- Is the +1 poll cycle latency a real problem for any plausible use case? (Realtime hot paths shouldn't use the bridge — use imperative `orchestrator.start()` from the use case. But is that documented clearly enough?)
- Does routing wrapper code into reserved pools muddy the "reserved = user can't target" rule? (Proposal: keep the rule; only framework-registered handlers can target.)

### Decision 1 — job-owned vs. event-owned triggers

User originally worried that event-owned triggers would force events to know about jobs. Settled on job-owned. Second opinion question: **is there any reason a declarative event-owned approach would be better at any scale?** (E.g., "this event fans out to these 15 things, visible in one file.") I argued no — the job owns its pool, concurrency, replay; adding trigger spec keeps behavior colocated. But a reviewer who's built reactive systems may have counter-arguments.

### Open question — where `bridgeRegistry` physically lives

Three candidates in the ADR's open questions section:
- `runtime/subsystems/events/generated/bridge.ts` (events-owned, but events subsystem shouldn't know about jobs)
- `runtime/subsystems/jobs/generated/bridge.ts` (jobs-owned, but bridge registry consults `eventRegistry`)
- `runtime/subsystems/bridge/generated/registry.ts` (my lean — new subsystem whose whole job is combining the other two)

Lean is option 3, which implies a new `BridgeModule.forRoot()` that imports `JobsDomainModule` + `EventsModule`. Keeps the import graph clean.

## Reading order for a reviewer

1. **Context + Decision sections of the ADR** (decisions 1 + 2 are the load-bearing ones).
2. **Alternatives considered** (4 rejected approaches with reasons — easiest place to find disagreement).
3. **Schema section** for `bridge_delivery` (small table, few columns — quick to evaluate).
4. **Open questions** at the bottom (all Phase-2 spec concerns, not ADR concerns).

Skip: the framework handler pseudocode is illustrative, not final — BRIDGE-4 will produce the actual implementation.

## User's known worries to sanity-check against

- **"`user.created` could generate a bunch of downstream jobs that slow stuff down."** Resolved in conversation — publish is O(1) insert, fanout is async on isolated pools, execution is bounded by pool concurrency. ADR's consequences section names this explicitly.
- **"I want layers of separation for control."** Drove decision 2 toward wrappers over direct spawn. Agent should check the control-plane argument holds: does pool-level concurrency on `events_*` actually give the knobs we claim?

## What the next reviewer should NOT do

- Rewrite the ADR. Comments / revision notes only.
- Push for backwards-compat shims. No users exist (CLAUDE.md operating principles).
- Propose adding a sweeper / retry scheduler for `bridge_delivery.failed`. Explicitly out of scope for Phase 2 (mirrors events outbox stance).
- Push for event-owned YAML as the *primary* authoring surface. It's deferred as a second, additive codegen source. Either direction is fine; changing the primary surface post-ship is a codegen migration.

## Next task if reviewer approves

Task #3 in the local task list: break ADR-023 into `docs/specs/BRIDGE-1.md` through `BRIDGE-9.md` following the shape of EVT-1..8 / JOB-1..8, plus `docs/specs/ADR-023-phase-2-issues.md` with a dependency graph.
