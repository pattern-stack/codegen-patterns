# BRIDGE Phase 2 — Orchestration Plan

**Status:** Ready for orchestration (execution will happen on a different machine).
**Captured:** 2026-04-21
**Scope:** codegen-patterns library changes only. Consumer adoption is outside this plan.
**Read before orchestrating:** `docs/adrs/ADR-023-event-to-job-bridge.md` (revised 2026-04-21) and `docs/specs/ADR-023-handoff.md`. Both are ADR-locked; no design work remains.

---

## Context

ADR-023 is revised and ready. It formalizes the seam between the events subsystem (ADR-024, shipped via EVT-1..EVT-8) and the jobs subsystem (ADR-022, shipped via JOB-1..JOB-8). The bridge is the single typed, observable, durable path from "event published" to "job started."

**Seven locked decisions** (cite freely in PR bodies):

1. Triggers are job-owned via `@JobHandler({ triggers: [...] })`
2. Bridge IS the jobs worker on reserved `events_*` pools (wrapper `job_run` per delivery)
3. Typed TS `map:` / `when:` callbacks (no YAML DSL)
4. Four-state `bridge_delivery.status`, no auto-retry
5. Build-time validation against `eventRegistry`
6. `when:` predicates ship in Phase 2
7. **`IEventFlow` facade** with two verbs (`publish`, `publishAndStart`) — all request-path and fanout publishing goes through this facade, not through `IEventBus` directly

**Resolved open questions**:
- New `runtime/subsystems/bridge/` subsystem with its own `BridgeModule.forRoot()`; registry at `runtime/subsystems/bridge/generated/registry.ts`
- Drain atomicity: per-event transaction within batch loop
- `publishAndStart` + existing `triggers:` collision: facade pre-writes `bridge_delivery(status=delivered)`, UNIQUE constraint dedups

**Scope boundaries**:
- Library-side only (this repo). Consumer adoption is out of scope.
- Both `clean` and `clean-lite-ps` pipelines should accept the facade; existing subsystem scaffold pattern from EVT/JOB/SYNC applies.
- No Phase 2.5 items (YAML authoring, `debounce:`, dashboard hiding) — deferred.
- No ADR-026 items — that's a separate ADR that happens to flow through this bridge.

---

## The 9-PR stack

Sequential — each builds on the previous. Assign to a single coordinator running sequential `/develop` loops.

| # | Branch | Issue | Scope | Gate |
|---|---|---|---|---|
| 1 | `bridge-1/drizzle-schema` | BRIDGE-1 | `runtime/subsystems/bridge/bridge-delivery.schema.ts`: `bridge_delivery` table + `bridge_delivery_status` enum. Round-trip tests. | `just test-unit` green. **CHECKPOINT** after merge (brief direction check). |
| 2 | `bridge-2/protocols` | BRIDGE-2 | `runtime/subsystems/bridge/bridge.protocol.ts`: `IJobBridge`, `IEventFlow` interfaces; DI tokens (`BRIDGE_DELIVERY_REPO`, `EVENT_FLOW`, `BRIDGE_MULTI_TENANT`); subsystem skeleton barrel `runtime/subsystems/bridge/index.ts`. | `just test-unit` green. |
| 3 | `bridge-3/memory-backend` | BRIDGE-3 | `MemoryBridgeDeliveryRepo` test double with ergonomic helpers (`getDeliveriesForEvent`, `getByStatus`). | `just test-unit` green. |
| 4 | `bridge-4/drizzle-backend` | BRIDGE-4 | `DrizzleBridgeDeliveryRepo` (Postgres impl) + outbox drain integration: drain inserts `bridge_delivery + wrapper job_run` per matched trigger inside per-event tx. **GATE** before opening — DB migration surface + drain modification. | `just test-unit` + integration test with real Postgres. |
| 5 | `bridge-5/framework-handler` | BRIDGE-5 | Framework `BridgeDeliveryHandler` (3 instances, one per reserved pool). Reads `bridge_delivery` → evaluates `when:` → calls `orchestrator.start(userJob)` → updates ledger. Step memoization for replay safety. | `just test-unit` + integration test showing wrapper → user job fanout. |
| 6 | `bridge-6/codegen` | BRIDGE-6 | Codegen: scan `@JobHandler.triggers` decorator metadata across handler files; emit `runtime/subsystems/bridge/generated/registry.ts`; build-time validation against `eventRegistry`; `just gen-all` hooks. | `just test-unit` + `just gen-all` succeeds on fixture. |
| 7 | `bridge-7/eventflow-facade` | BRIDGE-7 | `EventFlowService` implementation of `IEventFlow`. `publish()` delegates to `IEventBus`. `publishAndStart()` does: outbox insert + `orchestrator.start()` + (for Case B) pre-write `bridge_delivery(status=delivered)`. **GATE** before opening — facade dedup semantics against real `bridgeRegistry`. | `just test-unit` green, including Case A/B collision tests. |
| 8 | `bridge-8/module-wiring` | BRIDGE-8 | `BridgeModule.forRoot({ backend, multiTenant })` wiring repo + facade + registering framework handler on 3 reserved pools. Shared `assertTenantId` enforcement at all boundaries. **GATE** before opening — multi-tenancy review (mirrors JOB-8 / SYNC-6 precedent). | `just test-all` green end-to-end: publish → bridge delivery → user job execution. |
| 9 | `bridge-9/cli-scaffold-docs` | BRIDGE-9 | (a) Fanout CLI `codegen events consumers <type>` indexing all three tiers, (b) Hygen scaffold templates for `bun codegen subsystem install bridge`, (c) CONSUMER-SETUP section + `.claude/skills/bridge/` with load-on-touch triggers. **GATE** before opening — CLI UX + scaffold shape review. | `just test-all` green. Epic closes. |

**Gates where coordinator stops and reports** (same pattern as SYNC / CI-bootstrap orchestrations):

1. **CHECKPOINT after BRIDGE-1** — schema direction sanity check
2. **GATE before BRIDGE-4 opens** — DB migration + drain modification review
3. **GATE before BRIDGE-7 opens** — facade dedup semantics against real registry
4. **GATE before BRIDGE-8 opens** — multi-tenancy review (security-sensitive)
5. **GATE before BRIDGE-9 opens** — CLI UX + scaffold shape review
6. Any CI failure not diagnosed in 2 attempts
7. Any latent bug in another subsystem (events / jobs / sync / patterns / auth) — file separately, don't silently expand scope (discipline from CI-bootstrap and SYNC orchestrations)

---

## Files Touched (~30 total)

Estimated from the ADR's spec. The executing coordinator will refine as BRIDGE-1.md through BRIDGE-9.md are cut.

### NEW (12+ files)

```
# Subsystem layout
runtime/subsystems/bridge/bridge.protocol.ts
runtime/subsystems/bridge/bridge-delivery.schema.ts
runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts
runtime/subsystems/bridge/bridge-delivery.memory-backend.ts
runtime/subsystems/bridge/bridge-delivery-handler.ts
runtime/subsystems/bridge/event-flow.service.ts
runtime/subsystems/bridge/bridge.module.ts
runtime/subsystems/bridge/generated/registry.ts        # codegen emits
runtime/subsystems/bridge/index.ts                      # barrel

# Codegen
src/cli/shared/bridge-registry-generator.ts
src/cli/shared/bridge-scaffold-locals.ts

# Tests (per backend + facade)
src/__tests__/runtime/subsystems/bridge-delivery.schema.spec.ts
src/__tests__/runtime/subsystems/bridge-delivery.memory-backend.spec.ts
src/__tests__/runtime/subsystems/bridge-delivery.drizzle-backend.spec.ts
src/__tests__/runtime/subsystems/bridge-delivery-handler.spec.ts
src/__tests__/runtime/subsystems/event-flow.service.spec.ts
src/__tests__/cli/bridge-registry-generator.test.ts
src/__tests__/cli/bridge-scaffold-locals.test.ts

# Hygen scaffold
templates/subsystem/bridge/prompt.js
templates/subsystem/bridge/bridge-delivery.schema.ejs.t
templates/subsystem/bridge-config/prompt.js
templates/subsystem/bridge-config/codegen-config-bridge-block.ejs.t

# Skill
.claude/skills/bridge/SKILL.md
.claude/skills/bridge/routing.md
```

### MODIFY — runtime subsystems (~4)

```
runtime/subsystems/events/event-bus.drizzle-backend.ts   # outbox drain inserts bridge_delivery + wrapper job_run per matched trigger
runtime/subsystems/jobs/jobs-domain.module.ts            # reserves events_* pools for bridge wrappers; no new behavior, reference only
```

### MODIFY — CLI (~3)

```
src/cli/commands/subsystem.ts            # add 'bridge' dispatch path (runBridgeScaffold)
src/cli/shared/subsystem-detect.ts       # add 'bridge' to SubsystemName union
src/cli/shared/config-block-detect.ts    # add 'bridge' to config-block handling
src/cli/commands/events/consumers.ts     # NEW: `codegen events consumers <type>` CLI
```

### MODIFY — docs (~6)

```
docs/CONSUMER-SETUP.md                   # new "App-defined patterns"-style section for bridge
README.md                                # one-line subsystem mention
.claude/skills/events/SKILL.md           # cross-link to bridge
.claude/skills/events/phase-roadmap.md   # promote Phase 2 entry from deferred → shipped
.claude/skills/jobs/SKILL.md             # cross-link to bridge wrapper handler registration
docs/adrs/ADR-023-event-to-job-bridge.md # status: Revised → Shipped after BRIDGE-9 merges
```

---

## Risks (flag to the coordinator)

1. **Outbox drain modification is the most invasive change.** BRIDGE-4 touches the already-shipped EVT-4 (`event-bus.drizzle-backend.ts`). Baseline + smoke + unit tests must all pass; don't regress the drain's `FOR UPDATE SKIP LOCKED` claim or the per-event `processed_at` stamp.
2. **`publishAndStart` Case B dedup must be inside a single transaction** with the `orchestrator.start()` call, otherwise a crash between the two leaves the system inconsistent. Explicit in the spec; call it out in the BRIDGE-7 PR body.
3. **Framework handler registration on 3 pools** (one handler class registered 3× — one per direction) can trip DI if naively coded. Follow the EVT-6 `TYPED_EVENT_BUS` provider shape as precedent.
4. **Reserved-pool concurrency default**. Set a sane default (e.g., 32) for `events_*` pools. Too low → bridge latency spikes under load. Too high → wastes DB connection headroom. Document the knob in CONSUMER-SETUP.
5. **AST scan for fanout CLI** in BRIDGE-9 needs to correctly identify `eventFlow.publishAndStart(X, ...)` call sites. If the project uses non-standard injection patterns, the CLI may miss them. Document a fallback: if the AST scan finds zero call sites on a known-present facade user, emit a warning rather than silence.
6. **Multi-tenancy coverage**. When `multiTenant=true`, three enforcement sites need `assertTenantId`: (a) `EventFlowService.publishAndStart` entry, (b) `BridgeDeliveryHandler.handle` entry, (c) `DrizzleBridgeDeliveryRepo.insertDelivery` before write. Same error message shape at every site (precedent: JOB-8, SYNC-6).
7. **CI is live and gating.** All PRs must pass `test-all` before merge. No `--admin` bypass without explicit user approval. CI failures from pre-existing latent bugs in other subsystems (like CI-bootstrap and SYNC caught) should be filed as separate issues, not silently bundled.

---

## What's NOT in Phase 2

- **YAML authoring style** (`triggers/*.yaml`) — Phase 2.5
- **`debounce:` field** — Phase 2.5
- **Dashboard hiding of `@framework/bridge_delivery` runs** — Phase 2.5
- **ADR-026 observability** (selective JobEvent broadcast) — separate ADR, flows back through this bridge
- **Dual-mode triggers** (rejected Alternative F)
- **Direction-based auto-routing** (rejected Alternative G)
- **Event-owned triggers as primary surface** (rejected Alternative D)
- **Sweeper / retry scheduler for `bridge_delivery.failed`** — explicitly out of scope
- **Consumer adoption in sales-patterns-ts or other repos** — separate orchestrations

---

## Recommended GitHub Structure

When the executing session opens this work:

- **1 Epic issue**: "BRIDGE Phase 2 — event-to-job bridge subsystem." References ADR-023 revision + this plan. Lists the 9 sub-issues.
- **9 PR-sized issues** (BRIDGE-1 through BRIDGE-9), one per branch in the stack. Each issue body copies scope + file list + gate from this plan. Each links back to the epic.
- **Dependency chain in labels/body**: BRIDGE-2 blocks on BRIDGE-1; BRIDGE-3 on BRIDGE-2; …; BRIDGE-9 on BRIDGE-8.

Use `gh issue create --repo pattern-stack/codegen-patterns --title ... --body ...` for consistency with the SYNC epic structure (#60 + #126..#133).

---

## Orchestration Recommendation

**One coordinator, sequential `/develop` loops, single branch per issue, dedicated worktree.** Do not parallelize — each PR's output is the input to the next.

**Worktree setup** (from the executing machine):
```bash
git worktree add -b orch/bridge-phase2 \
  /path/to/codegen-patterns-bridge \
  main
```

**Coordinator spawn** (pattern matching the SYNC + Patterns Phase 1 + CI-bootstrap orchestrations — act as architect + builder + validator in one thread; team tools not required):

Use `coordinator` agent type with:
- `model: opus`
- `mode: bypassPermissions`
- Pre-created worktree path (do not let agent create its own)
- Issues listed with dependencies
- Gate locations explicitly named (5 gates from the table above)
- File-based reporting protocol (`.orchestration-gate-<n>.md` / `.orchestration-checkpoint-<n>.md`) since `SendMessage` isn't typically available inside coordinator
- CI gate warnings: `test-all` enforced on main; no `--admin` without approval

The coordinator should:
1. `cd` into the worktree
2. Read ADR-023 + this plan + handoff doc
3. Create 9 GitHub sub-issues under a new epic (or confirm they exist)
4. For each issue:
   - Branch off latest `main`
   - Implement + test locally via `just test-all`
   - Open PR, wait for CI green
   - Self-review
   - Squash-merge + delete branch
   - Report via file if gate; proceed otherwise

---

## Dependency / Sequencing Notes

- **This plan is independent of any in-flight TEST-SESSION-2 or observability (ADR-026) work.** Ship standalone.
- **ADR-026 unblocks after Phase 2 lands.** That work can either run in parallel in a different session (touching `JobEventLogger`, not the bridge) or be sequenced after.
- **No sales-patterns-ts coupling.** Consumers adopt the bridge at their own pace in separate sessions.
- **Current main state (as of 2026-04-21, commit `9cca553`):** Patterns Phase 1 + CI bootstrap + SYNC Phase 1 + small-bug cleanup all shipped. The next commit on main is expected to be this plan doc and the ADR revision.

---

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` (revised 2026-04-21) — binding decisions
- `docs/specs/ADR-023-handoff.md` — revision summary + what the executing session should / should not do
- `docs/adrs/ADR-022-job-orchestration-domain-model.md` — reserved `events_*` pools originate here
- `docs/adrs/ADR-024-events-domain-formalization.md` — typed registry this ADR builds on
- `docs/adrs/ADR-026-job-observability.md` — not yet written; flows back through this bridge
- `docs/specs/PATTERNS-PHASE-1-PLAN.md` — structural precedent for this plan doc
- `.claude/skills/events/phase-roadmap.md` — Phase 2 entry to be promoted
- SYNC epic (#60) + PRs #148–#154 — structural precedent for subsystem scaffolding
- Patterns epic (#75) + PRs #142–#145 — structural precedent for doc-heavy first PR
