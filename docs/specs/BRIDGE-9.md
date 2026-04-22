# BRIDGE-9 — Fanout CLI, Hygen Scaffold, CONSUMER-SETUP, Skill

**Issue:** BRIDGE-9
**Status:** Shipped 2026-04-22
**Phase:** ADR-023 Phase 2 (epic closes with this PR)
**Depends on:** BRIDGE-8.
**Blocks:** Nothing. Epic #158 closes on merge.

## Overview

Three parallel deliverables, all in one PR (they share review context and close the epic together):

1. **Fanout CLI.** `codegen events consumers <event_type>` — indexes all three tiers (Tier 1 `@OnEvent` subscribers, Tier 2 `publishAndStart` call sites via AST scan, Tier 3 `bridgeRegistry`). Output: a single report with three sections and file:line citations. Committed in ADR-023 §Three tiers of event-driven work.
2. **Hygen scaffold.** `bun codegen subsystem install bridge` scaffolds the subsystem runtime files into a fresh project and injects the `bridge:` config block.
3. **Docs + skill.** `docs/CONSUMER-SETUP.md` gains a "Bridge subsystem" section; `.claude/skills/bridge/` is created with `SKILL.md` + `routing.md`. Events phase-roadmap Phase 2 entry flips from deferred → shipped. ADR-023 status flips `Revised` → `Shipped`.

## Context

**What exists after BRIDGE-8.** The bridge is fully operational in consumer projects that manually import `BridgeModule`. No CLI installation path, no documentation, no discoverability.

**What this PR adds.** The surfaces users touch: the install command, the fanout report, the setup doc, the skill.

## Architecture

```
CLI — codegen events consumers <type>
  ├── Tier 3 (bridge): read runtime/subsystems/bridge/generated/registry.ts, filter by type
  ├── Tier 2 (facade): AST-scan source files for calls matching *.publishAndStart(<type>, ...)
  │   Fallback: if zero call sites found AND EventFlowService is present in AppModule imports,
  │              emit WARN (not error): "scan may be missing non-standard injection patterns"
  └── Tier 1 (subscribers): AST-scan for @OnEvent('<type>') decorators and IEventBus.subscribe('<type>', ...) calls
  render report:
    Event: user.created
    Tier 3 — Bridge triggers (2):
      - send_welcome_email#0     (src/jobs/send-welcome-email.job.ts:14)
      - provision_workspace#0    (src/jobs/provision-workspace.job.ts:18)
    Tier 2 — Direct invoke via publishAndStart (1):
      - src/use-cases/signup.uc.ts:42
    Tier 1 — Subscribers (1):
      - MetricsListener.@OnEvent('user.created') at src/observability/metrics.ts:28

Hygen scaffold — templates/subsystem/bridge/
  prompt.js
  bridge.module.ejs.t
  bridge.protocol.ejs.t
  bridge.tokens.ejs.t
  bridge-errors.ejs.t
  bridge-delivery.schema.ejs.t
  bridge-delivery.memory-backend.ejs.t
  bridge-delivery.drizzle-backend.ejs.t
  bridge-delivery-handler.ejs.t
  event-flow.service.ejs.t
  assert-tenant-id.ejs.t
  index.ejs.t
  generated-dir.ejs.t (emits generated/.gitkeep)

Hygen scaffold — templates/subsystem/bridge-config/
  prompt.js
  codegen-config-bridge-block.ejs.t  → injects:
    bridge:
      backend: drizzle
      multi_tenant: false

Skill — .claude/skills/bridge/
  SKILL.md     load-on-touch triggers + current-state snapshot
  routing.md   lookup table: "what do I need?" → which deeper file

Docs — docs/CONSUMER-SETUP.md "Bridge subsystem" section
  - Install: bun codegen subsystem install bridge
  - Authoring triggers: @JobHandler({ triggers: [...] })
  - When NOT to use the bridge (→ publishAndStart) [ADR latency guardrails]
  - Ordering guidance (both knobs — see Implementation Notes)
  - Reserved-pool concurrency default: 32
  - Trigger rename/removal (orphan handling)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/cli/commands/events/consumers.ts` | create | Fanout CLI |
| `src/cli/commands/subsystem.ts` | modify | Add 'bridge' dispatch (runBridgeScaffold) |
| `src/cli/shared/subsystem-detect.ts` | modify | 'bridge' in SubsystemName |
| `src/cli/shared/config-block-detect.ts` | modify | 'bridge' config-block handling |
| `src/cli/shared/bridge-scaffold-locals.ts` | create | Locals-builder for Hygen |
| `src/__tests__/cli/bridge-scaffold-locals.test.ts` | create | Unit |
| `src/__tests__/cli/events-consumers.test.ts` | create | CLI tests incl. fallback warn |
| `templates/subsystem/bridge/prompt.js` | create | Hygen prompt |
| `templates/subsystem/bridge/*.ejs.t` | create | One per runtime file |
| `templates/subsystem/bridge-config/prompt.js` | create | Config-block prompt |
| `templates/subsystem/bridge-config/codegen-config-bridge-block.ejs.t` | create | Config injector |
| `docs/CONSUMER-SETUP.md` | modify | Bridge subsystem section |
| `README.md` | modify | One-line subsystem mention |
| `.claude/skills/bridge/SKILL.md` | create | Skill root |
| `.claude/skills/bridge/routing.md` | create | Routing table |
| `.claude/skills/events/SKILL.md` | modify | Cross-link to bridge |
| `.claude/skills/events/phase-roadmap.md` | modify | Phase 2 → shipped |
| `.claude/skills/jobs/SKILL.md` | modify | Cross-link to wrapper handler |
| `docs/adrs/ADR-023-event-to-job-bridge.md` | modify | Status: Revised → Shipped |

## Implementation Notes

### Fanout CLI fallback (plan doc risk #5)

If the AST scan for `publishAndStart` call sites returns zero hits, **do not be silent**. Run a second AST pass to detect whether `EventFlowService` or `EVENT_FLOW` is imported/injected anywhere in the project. If yes, emit:

```
WARN: no `publishAndStart` call sites found for event 'X', but EventFlowService
      is present in the codebase. The scan may miss non-standard injection
      patterns (e.g., property injection, dynamic dispatch). Verify Tier 2
      fanout manually.
```

Do not fail the command. This catches projects using patterns the standard AST scanner doesn't reach — better a false-positive warning than silent data loss.

### CONSUMER-SETUP ordering guidance (ADR §Ordering guarantee + plan risk coverage)

The "When NOT to use the bridge" + "Ordering" subsection must explicitly cover **both** knobs and their tradeoff:

1. **`jobs.pools.events_<direction>.concurrency = 1`** — blunt. Serializes **all** wrappers in that direction pool → serializes every bridge fanout for that direction end to end. Simplest config; highest throughput cost. Use when all events in a direction genuinely need strict order.

2. **`concurrency_key` on the user job's `@JobHandler`** — granular. Example: `concurrency_key: (ctx) => ctx.input.accountId`. Per-aggregate serialization; parallelism preserved across unrelated aggregates. Use when only same-aggregate ordering is required.

The doc must name both explicitly and link to ADR-023 §Ordering guarantee for the full reasoning. Default configuration gives parallelism, not ordering.

### Reserved-pool concurrency default

Document `events_*.concurrency = 32` as the recommended default in CONSUMER-SETUP. This is the knob mentioned in plan doc risk #4. Too low → bridge latency spikes under load. Too high → wastes DB connection headroom.

### Trigger rename/removal (ADR-023 neutral case)

Document: renaming a job type changes `triggerId`. In-flight `pending` deliveries with the old trigger id are orphaned. Handler marks them `skipped` with `skip_reason='trigger_unregistered'`. No auto-migration. Include example and pointer to ADR.

### Skill structure

Mirror `.claude/skills/events/` and `.claude/skills/jobs/` — `SKILL.md` at root with routing table + current-state snapshot + load-on-touch triggers; `routing.md` with deeper lookup. Phase 2 shipped artifacts enumerated. Reference `docs/specs/BRIDGE-*.md` for post-mortem detail.

## Acceptance Criteria

- [ ] `codegen events consumers user.created` prints a single report with three tier sections and file:line citations.
- [ ] AST scan identifies `<any>.publishAndStart('user.created', ...)` patterns including `eventFlow.`, `this.eventFlow.`, and injected-via-constructor shapes.
- [ ] **Fallback warn path covered by test**: fixture with `EventFlowService` imported but zero `publishAndStart` calls → WARN on stderr, exit 0.
- [ ] `bun codegen subsystem install bridge` scaffolds all runtime files + `generated/.gitkeep` + injects `bridge:` config block with `backend: drizzle`, `multi_tenant: false`.
- [ ] `docs/CONSUMER-SETUP.md` "Bridge subsystem" section includes: install command, trigger authoring, "When NOT to use the bridge", ordering guidance (both knobs named), reserved-pool concurrency default (32), trigger rename/removal, multi-tenancy.
- [ ] `.claude/skills/bridge/SKILL.md` + `routing.md` created; routing rows added to `.claude/skills/events/SKILL.md` and `.claude/skills/jobs/SKILL.md`.
- [ ] `.claude/skills/events/phase-roadmap.md` Phase 2 entry flipped from deferred → shipped.
- [ ] ADR-023 status: `Revised` → `Shipped`.
- [ ] `README.md` subsystem list updated.
- [ ] `just test-baseline` passes with updated snapshots.
- [ ] `just test-all` green. Epic closes.

## Testing Strategy

- **Unit** (`bridge-scaffold-locals.test.ts`, `events-consumers.test.ts`): locals-builder stable; CLI report rendering; fallback-warn path.
- **Baseline** (`just test-baseline`): scaffold snapshot matches expected file set.
- **Manual (documented in PR)**: run `bun codegen subsystem install bridge` against a fresh `test/scaffold/` checkout; run full end-to-end flow.

## Gate/Checkpoint

**GATE before opening PR** — CLI UX + scaffold shape review. Coordinator reports via `.orchestration-gate-9.md`. User confirms:
- CLI report format is useful and greppable.
- Fallback warning wording is clear.
- Scaffold file set matches the subsystem's shipped structure.

## Open Questions

- [ ] **Handler-directory AST scan roots.** If projects use non-standard handler directories (not the default `src/jobs/`), the `publishAndStart` scanner needs a config knob (`codegen.config.yaml: scan.roots`?) or it defaults to TS rootDir. Implementer picks; documents in PR.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Three tiers of event-driven work, §Ordering guarantee, §Trigger rename or removal
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 9, risks #4, #5
- `docs/specs/EVT-8.md` — scaffold + docs + skill precedent
- `docs/specs/JOB-6.md` — Hygen subsystem scaffold precedent

## Implementation Notes (post-ship, 2026-04-22)

### Actual files shipped

**CLI — `codegen events consumers <type>`:**
- `src/cli/commands/events.ts` — single-file noun module (not a directory). Defines `EventsConsumersCommand`, the tier-2/tier-1 AST scanner (`scanSourceFileForConsumers`, `scanDirectoryForConsumers`), the report renderer, the Levenshtein suggestion helper, and the `eventsNoun` NounModule default export.
- `src/cli/index.ts` — already loaded this noun via the generic dynamic-import block.

**Hygen scaffold — lean 3-file shape:**
- `templates/subsystem/bridge/prompt.js`, `templates/subsystem/bridge/generated-keep.ejs.t` — only the `.gitkeep` under `generated/`. No schema template (BRIDGE-1's `tenant_id` column is unconditional; multi-tenancy is runtime enforcement, not a schema branch). No runtime-file templates — the bridge runtime flows through `copyRuntime` unchanged.
- `templates/subsystem/bridge-config/prompt.js`, `templates/subsystem/bridge-config/codegen-config-bridge-block.ejs.t` — `bridge:` block injector.

Deviation from spec's 13-template list: only 3 templates ship (see GATE 5 decision + `src/cli/shared/bridge-scaffold-locals.ts` docstring). EVT-8 precedent.

**Scaffold dispatch + shared locals:**
- `src/cli/commands/subsystem.ts` — `runBridgeScaffold` wired alongside jobs / events / sync scaffold hooks.
- `src/cli/shared/bridge-scaffold-locals.ts` + `src/__tests__/cli/bridge-scaffold-locals.test.ts` — pure locals resolver + tests.
- `src/cli/shared/subsystem-detect.ts` — `'bridge'` added to `SubsystemName` + `SUBSYSTEMS` descriptor table.
- `src/cli/shared/config-block-detect.ts` — `'bridge'` added to `SubsystemName` union.
- `src/__tests__/cli/subsystem.test.ts` — existing suite extended to assert all six subsystem descriptors are present.

**Tests:**
- `src/__tests__/cli/events-consumers.test.ts` — covers happy path (all three tiers), empty case (`(none)` bullets + "no consumers found"), unknown event type + suggestions, fallback warn path (EventFlowService present + zero Tier 2 hits), subscriber decorator matching, `subscribe()` matching, and node_modules/generated skipping.

**Docs:**
- `docs/CONSUMER-SETUP.md` — new *Bridge subsystem* section covering install, trigger authoring, reserved-pool wiring (`BRIDGE_RESERVED_POOLS` spread, concurrency-32 default), fanout CLI, "When NOT to use the bridge" decision table, ordering guidance (both `pools.events_*.concurrency = 1` and `concurrency_key` knobs named), multi-tenancy, trigger rename orphan handling, retention → BRIDGE-10 forward reference.
- `README.md` — subsystem list extended to include `sync` + `bridge`; `codegen events consumers <type>` one-line mention.
- `docs/adrs/ADR-023-event-to-job-bridge.md` — status flipped `Revised` → `Shipped 2026-04-22`.

**Skill (not shipped in this PR — permissions issue):**
- `.claude/skills/bridge/SKILL.md` + `routing.md` updates blocked by harness-level write permission on `.claude/skills/*`. Filed as a follow-up; content is drafted in the PR body for manual application by the maintainer.

### Deviations from spec

1. **Scaffold shape:** 3 templates instead of 13 — GATE 5 approved; `copyRuntime` handles the runtime files identically to events / sync (no skip-list entry needed because the schema column is unconditional).
2. **Fanout CLI location:** `src/cli/commands/events.ts` (file) not `src/cli/commands/events/consumers.ts` (directory). Single-verb noun; matching the shape of `src/cli/commands/entity.ts`.
3. **Empty-tier rendering:** always show `  - (none)` under each tier header (GATE 5 decision for greppability). The spec suggested collapsing empty tiers; rejected for consistency.
4. **Unknown event type** warns to stderr and exits 0 (GATE 5: tools never gate CI). Suggestion list uses Levenshtein over `eventRegistry` keys.
5. **Retention** is NOT in this PR. Forward-reference stub added to CONSUMER-SETUP pointing at BRIDGE-10 (#173) as fast-follow.
6. **Open Question — handler-directory AST scan roots:** resolved by defaulting to `<cwd>/src/` with no config knob in Phase 2. `findHandlerFiles` already skips `node_modules`, `generated/`, dotfiles, `.d.ts`.
