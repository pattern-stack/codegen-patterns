# ADR-023 Handoff — Event-to-Job Bridge

**Status:** ✅ review pass complete (2026-04-21). ADR revised, ready for spec cutting.
**Primary artifact:** `docs/adrs/ADR-023-event-to-job-bridge.md`
**Orchestration plan:** `docs/specs/BRIDGE-PHASE-2-PLAN.md`
**Related context:** ADR-022 (jobs), ADR-024 (events), `.claude/skills/events/phase-roadmap.md` (Phase 2 entry).

## What happened in the review pass

User reviewed the original draft with a second agent on 2026-04-21. The pass produced 10 additions / clarifications, none of which rewrite the original decisions. All are captured inline in the revised ADR under the `2026-04-21 Revision Notes` section at the top.

**Decisions 1–6 stand unchanged.** A new **Decision 7** (developer-facing facade) was added. Open Questions 1, 2, 3, and a new 5 are resolved in the revised doc.

### Summary of revision content

1. **Three-tier model** framed explicitly: subscribe (in-process, lossy, ms) / direct invoke (request-path, durable, 1 poll cycle) / bridge (async fanout, durable, 2–3 poll cycles). Decision tree included.
2. **New Decision 7: `IEventFlow` facade** with two verbs — `publish` and `publishAndStart`. Resolves authoring-consistency gap; makes tiers grep-friendly.
3. **`publishAndStart` + existing `triggers:` collision** resolved by pre-writing `bridge_delivery(status=delivered)` so drain's UNIQUE dedups.
4. **New subsystem `runtime/subsystems/bridge/`** — resolves Open Q1 + Q3. Has its own `BridgeModule.forRoot({ multiTenant })` that imports Events + Jobs modules.
5. **Drain atomicity**: per-event transaction within batch loop. Resolves Open Q2.
6. **Pool alignment guidance** added: two pool layers (events_* wrappers + user pools), pool-per-class-of-work.
7. **Latency guardrails** on Decision 2: hop-count table, JSDoc on `triggers:` field, "When NOT to use the bridge" CONSUMER-SETUP section committed.
8. **Reverse-lookup CLI** `codegen events consumers <type>` committed to Phase 2 scope — indexes all three tiers.
9. **Primer section** *events are facts, jobs are work* for new readers.
10. **Edge cases added to Consequences**: trigger rename/removal (orphan handling), payload schema evolution rules, multi-tenancy null-tenantId error path, ordering guarantees.

### Two new rejected alternatives recorded (F, G)

- **F. Dual-mode triggers** (`mode: 'bridge' | 'immediate'` on the decorator) — rejected; use case doesn't exist yet; would hide execution semantics.
- **G. Direction-based auto-routing** (direction picks tier automatically) — rejected; direction is provenance, not latency profile.

## Next step for the executing session

Branch off latest `main` and:

1. Cut specs: `docs/specs/BRIDGE-1.md` through `docs/specs/BRIDGE-N.md` following the shape of EVT-1..8 / JOB-1..8 / SYNC-1..8. PR stack is in `docs/specs/BRIDGE-PHASE-2-PLAN.md`.
2. File GitHub issues per spec (one epic + N sub-issues, like `#60 + #126..#133` for SYNC).
3. Orchestrate per the plan doc's recommendation (single coordinator, sequential `/develop` loops, worktree isolation, three pre-agreed gates).

The plan doc is **execution-ready**. It specifies file paths, gate locations, dependency order, and the coordinator's first action.

## User's known worries — status after revision

- **"`user.created` could generate a bunch of downstream jobs that slow stuff down."** Resolved. Publish is O(1) insert; fanout is async on isolated pools; execution is bounded by pool concurrency. Consequences section names this.
- **"I want layers of separation for control."** Drove Decision 2 (wrappers over direct spawn). Pool-level concurrency on `events_*` provides the control knob; pool alignment guidance documents how to pick user pools to avoid head-of-line blocking.
- **"Leaving delegation to implementer style produces inconsistency."** Resolved by Decision 7 (facade).
- **"I don't love not knowing which path skipped a step."** Resolved by the three-tier model + fanout CLI: all three tiers are visible in the same report; `grep publishAndStart` + `grep @JobHandler.triggers` + `grep @OnEvent` cover them.
- **"Pools need to align to event types."** Refined: pool-per-class-of-work, not per-event-type. Documented in *Pool alignment guidance*.

## What the next session should NOT do

- Rewrite the ADR. It's been through the review pass and is locked for Phase 2.
- Push for backwards-compat shims. No users exist (CLAUDE.md operating principles).
- Propose adding a sweeper / retry scheduler for `bridge_delivery.failed`. Explicitly out of scope for Phase 2.
- Re-open dual-mode triggers (F) or auto-routing (G) — rejected alternatives are recorded with reasoning.
- Push for event-owned YAML as the *primary* authoring surface. It's deferred as a second, additive codegen source.
