# Handoff — Wire the bridge into the CRM

**For:** a fresh Claude Code session opened in the CRM repo.
**From:** 2026-04-22, post-BRIDGE Phase 2 ship (codegen-patterns `@pattern-stack/codegen@0.2.0`, main at `617a07e`).
**Mission:** adopt the Event-to-Job Bridge subsystem in the CRM so every domain event we already emit can fan out to durable jobs via declared triggers, and so request-path code can use `eventFlow.publishAndStart()` instead of raw `eventBus.publish()` + manual `orchestrator.start()`.

This doc tells you where to look, what to load, and how to plan the work. **Do not skip the pre-reads.** The bridge has a handful of non-obvious rules (reserved pools, UNIQUE dedup, enforcement sites) that will bite you if you try to infer them from the code.

---

## Package under test

- **Name:** `@pattern-stack/codegen` (v0.2.0)
- **Path on this machine:** `/Users/dug/Projects/codegen-patterns`
- **Main branch:** up to date, bridge subsystem shipped as of commit `617a07e`.
- **Key PR for bridge surface:** #177 (BRIDGE-9) — CLI + Hygen scaffold + `docs/CONSUMER-SETUP.md` §Bridge.
- **Binary:** `bun codegen` / `just gen-all` (see `justfile`).

The CRM's `package.json` likely already depends on `@pattern-stack/codegen`. Confirm version ≥ 0.2.0. If it's older, bump it first — the bridge does not exist in 0.1.x.

---

## Required pre-reads (in this order)

Open these in the codegen-patterns checkout before touching the CRM:

1. **`docs/CONSUMER-SETUP.md` §Bridge subsystem** (line ~428 onward) — **this is the authoritative consumer guide**. Covers install, config block, pool wiring, trigger authoring, fanout CLI, multi-tenancy, ordering, rename/retention. Read end-to-end.
2. **`docs/adrs/ADR-023-event-to-job-bridge.md`** — the seven locked decisions. Skim §Decisions; read §Schema and §Three tiers carefully. Do not re-open decisions.
3. **`.claude/skills/bridge/SKILL.md`** — mental model, non-obvious rules, "Do not" list. Load this if the CRM session triggers anything under the bridge (framework-side perspective, but useful for understanding).
4. **`.claude/skills/events/SKILL.md`** + `phase-roadmap.md` + `directions-and-pools.md` — the events side (you'll need `TypedEventBus`, directions, the outbox).
5. **`.claude/skills/jobs/SKILL.md`** — the jobs side (pools, `@JobHandler`, concurrency keys). Pay attention to the reserved `events_*` pool rules.

Skip or defer:
- `docs/specs/BRIDGE-1..9.md` — implementation specs for the framework work; not relevant to consumer adoption.
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — orchestration plan; historical.

---

## The three tiers (memorize this)

The bridge formalizes three ways to react to a domain event. Your CRM already uses some of these; the goal of this work is to pick the right tier per use case and migrate where appropriate.

| Tier | Mechanism | Durability | Latency | Use for |
|---|---|---|---|---|
| 1. Subscribe | `@OnEvent('X')` in-process | none (at-most-once) | ~ms | metrics, cache busts, logs |
| 2. Direct invoke | `eventFlow.publishAndStart(event, jobType, input)` | yes (caller tx) | ~1 poll cycle | request-path work needing durability |
| 3. Bridge | `@JobHandler({ triggers: [{ event, map, when }] })` | yes (outbox + ledger) | 2–3 poll cycles | durable async fanout |

**Rule of thumb:**
- If the reaction is cheap + lossy-OK → Tier 1 (leave `@OnEvent` alone).
- If the caller needs the job run id returned synchronously (request path) → Tier 2.
- If the reaction is async fanout, cross-aggregate, or independently-scalable → Tier 3.

---

## Work breakdown (suggested plan — propose your own after reading)

### Phase A — install + boot
1. Confirm `@pattern-stack/codegen` version. Bump if < 0.2.0.
2. Run `bun codegen subsystem install bridge` + `bun codegen subsystem install bridge-config` at the CRM repo root.
3. Add `BridgeModule.forRoot({ backend: 'drizzle', multiTenant: <match CRM> })` to `AppModule` imports.
4. Update `JobWorkerModule.forRoot({ pools: [...BRIDGE_RESERVED_POOLS, ...existingUserPools] })` — this is the **single most common footgun**. Without it, wrappers sit forever. BridgeModule will throw at boot with a clear error if you forget; heed the message.
5. Run `just db-push` (or whatever the CRM uses) to apply the `bridge_delivery` schema + enum.
6. Boot the app. Verify no `BridgeReservedPoolsNotPolledError`. Check `SELECT * FROM jobs WHERE type='@framework/bridge_delivery'` — three rows should exist (one per direction).

### Phase B — audit existing consumers
7. Use the fanout CLI: **`bun codegen events consumers <type>`** per event type. This reports Tier 1 subscribers, Tier 2 `publishAndStart` callsites, Tier 3 bridge triggers for each event.
8. Enumerate the CRM's domain events (the files under `events/*.yaml` or wherever the event registry lives). For each, ask:
   - Are there downstream jobs we spawn manually today (Tier 2 candidate)?
   - Are there async reactions buried in subscribers that should be Tier 3 (durable fanout with retries)?
9. Produce a migration map: event → tier-to-use → target jobType.

### Phase C — migrate to the bridge, one event at a time
10. For each Tier 3 migration: add a `triggers: [{ event, map, when? }]` entry to the target `@JobHandler` class. Run `just gen-all` to refresh `bridgeRegistry`. Build-time validation will catch typos.
11. For each Tier 2 migration: replace `eventBus.publish() + orchestrator.start()` pairs with `eventFlow.publishAndStart(event, jobType, input)`. Same-tx dedup is handled by the facade.
12. Prefer small PRs — one event at a time, each with a test showing the wrapper + user job ran.

### Phase D — observability + retention
13. Add dashboards or log filters for `bridge_delivery.status` (delivered / skipped / failed counts per event type).
14. Note BRIDGE-10 (bridge_delivery retention sweep) is **not yet shipped**. If the CRM is high-volume, track it — issue #173 on `pattern-stack/codegen-patterns`.

---

## Non-obvious rules (will bite you)

Full list in `docs/CONSUMER-SETUP.md` and the bridge skill. Highlights:

- **Reserved pools are claimed by the framework handler only.** Never put a user `@JobHandler` on `events_inbound | events_change | events_outbound`. Module init rejects it with a clear error.
- **`trigger_id = '<jobType>#<triggerIndex>'`**, stable across codegens. Don't hand-author trigger IDs.
- **Ordering is NOT default.** Need per-aggregate ordering? Use `concurrency_key` on the user job (granular) — not `pool.concurrency = 1` (blunt serializer).
- **`publishAndStart` + declared `triggers:` collision is handled via UNIQUE dedup on `(event_id, trigger_id)`.** The facade pre-writes a `delivered` row in the same tx as the eager `orchestrator.start()`; the drain's later insert loses the race and is skipped. Exactly one execution per pair.
- **Multi-tenancy:** if `multiTenant=true`, `opts.tenantId` is required at `publishAndStart`; `undefined` throws `MissingTenantIdError`. Pass `null` explicitly for cross-tenant work.
- **Null direction:** events published without direction metadata (legacy producers bypassing `TypedEventBus`) skip bridge fanout; drain logs a warning but still dispatches in-process subscribers + stamps `processed_at`. Audit for these.

---

## What NOT to build in this session

- **No retention sweep.** That's BRIDGE-10 (#173 on `pattern-stack/codegen-patterns`), fast-follow. If row volume matters, track it separately, don't build it ad-hoc in the CRM.
- **No YAML `triggers:*.yaml` authoring style.** Decided against in ADR-023 Alternative D. Triggers are job-owned.
- **No framework changes.** If you hit a bug in the bridge, file an issue on `pattern-stack/codegen-patterns` and work around it — do not edit the vendored runtime in the CRM.
- **No frontend work.** That's the next session. The jobs/events admin UI comes after bridge adoption.

---

## Starter prompt for your first turn

Paste this into a fresh session opened at the CRM repo root:

> I'm adopting the Event-to-Job Bridge from `@pattern-stack/codegen` v0.2.0 in this CRM. Handoff doc is at `/Users/dug/Projects/codegen-patterns/docs/handoffs/CRM-BRIDGE-ADOPTION.md`. Read it, then the required pre-reads it lists (CONSUMER-SETUP.md §Bridge, ADR-023, the bridge/events/jobs skills). Then audit this CRM repo: list the domain events, show what Tier 1/2/3 consumers exist today, and propose a migration plan. Do not start coding until I approve the plan.

---

## Gotchas logged from Phase 2 build

These caught the Phase 2 coordinator; you'll likely hit them too:

- `JobWorkerModule.forRoot({ pools })` defaults to non-reserved pools only — reserved `events_*` pools won't be polled unless you spread `BRIDGE_RESERVED_POOLS`. Fail-fast at boot is built in but the first-time read of the error is still confusing.
- The framework handler registers ONCE via `@JobHandler` (even though there are three reserved pools). Per-direction routing happens via the row's `pool` column, not per-registration. ADR-023 had a misconception here that was corrected in Phase 2; the bridge skill reflects the fixed shape.
- `IJobOrchestrator.start` gained an optional `tx?` parameter in BRIDGE-7 for the facade's same-tx requirement. Memory backend ignores it; Drizzle backend uses `tx ?? this.db`.

---

## Contact / escalation

- Framework package repo: `pattern-stack/codegen-patterns` on GitHub.
- BRIDGE epic (closed): #158. All 9 shipped PRs linked from there.
- BRIDGE-10 (retention, open): #173.

If a consumer-adoption blocker surfaces that requires a framework change, file a new issue on `pattern-stack/codegen-patterns` with a clear repro from the CRM side. Do not hand-patch the vendored runtime — that path is explicitly out of scope per ADR-023 §Consumer adoption.
