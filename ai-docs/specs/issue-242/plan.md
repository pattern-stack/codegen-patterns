# Audit Tier — PR-Sized Plan (successor to PR #219)

## 1. Context

PR #219 (`feat(events): tier: audit — bridge-inert events for lifecycle/observability`) ships the design + Zod schema for an audit event tier but is currently open and conflict-prone. The motivating incident is dealbrain-v2's CRM sync: 30 lifecycle events per no-op re-sync, all routed through `events_change`, each generating an inert wrapper job. The fix is structural — lifecycle/observability events are a different category from domain writes (subscribers may *observe* but jobs may *not* trigger), and routing them through a pool/direction was always a category error.

This plan takes #219 from "design merged" to "consumers can rely on it." The work is sequenced as five PRs landing into the existing events subsystem: schema → generator → runtime → bridge guard → viewer. Audit-tier semantics are enforced at the codegen layer (registry rejects misuse) and at the bridge layer (defense-in-depth runtime guard); the bus API stays uniform across tiers.

**Key decisions locked here:**

- **Q1 — `tier` is a first-class column on `domain_events`,** not metadata JSONB. Same reasoning as EVT-1 Phase A's promotion of `pool`/`direction`: indexable, cheap to filter on, single migration. Per CLAUDE.md "no backwards compat" — pay the cost once.
- **Q2 — `IEventBus.subscribe()` semantics stay convention.** Audit events are subscribe-able and not bridge-able. The codegen registry + bridge guard enforce the contract; the bus API is uniform across tiers. No typed marker, no separate `AuditEventBus`. Revisit only if a real misuse appears.
- **Q3 — No `tier: 'metric'` (or third tier) for now.** The binary `domain` / `audit` split tracks a real semantic boundary (subscribers-may-react vs. subscribers-may-only-observe). A third tier needs a third semantic; "metric" doesn't have one yet — it's just "audit for dashboards." Add when a concrete use case can't be modeled by the binary.
- **Q4 — Viewer default is `tier=domain`,** with a `tier=all` toggle that visually demotes audit rows. Generic consumers want audit hidden by default; debugging the sync pipeline (or any audit-relevant scenario) toggles them in. Both are cheap; no compromise.
- **Q5 — The bridge guard is defense-in-depth, not the primary enforcement.** Codegen errors are load-bearing. Guard exists to catch registry/runtime drift (out-of-band `bridge_trigger` inserts, version skew during deploy). Logs WARN + increments `bridge.audit_event_blocked` counter when triggered.

**Consumer coordination:** dealbrain-v2 will land their consumer-side patch (lifecycle stamping at emit sites for `crm_sync_started/completed/failed`, plus the same bridge guard) locally before AUDIT-3 ships. The `metadata.tier` key/value shape MUST be locked in the Zod schema during the #219 rebase so dealbrain's local stamping matches byte-for-byte; otherwise they have a silent migration when AUDIT-2 ships.

**Pre-work (not part of this plan):** Rebase + merge PR #219. Verify whether the 32 test/baseline ride-along files in #219 are real diffs (registry output gaining a `tier` field changes every emitted entry) or stale regen — if real, they belong in AUDIT-2's baseline refresh, not the rebase.

## 2. Issue list

---

### AUDIT-1: Schema — `tier` column + nullable `pool`/`direction` + CHECK constraint

**Scope:** Migration on `runtime/subsystems/events/domain-events.schema.ts`:
- Add `tier text not null default 'domain'`.
- Loosen `pool` and `direction` to nullable.
- Add CHECK: `tier in ('domain','audit') AND ((tier='audit') = (pool is null and direction is null))` — i.e., audit ⇔ both null; domain ⇒ both populated.
- Add index on `(tier, status, occurred_at)` for viewer filter queries (mirrors EVT-1's `(pool, status, occurred_at)` precedent).
- Backfill: existing rows get `tier='domain'` via the column default; no data migration needed.
- Update memory backend (`runtime/subsystems/events/memory/`) row shape to match.
- Lock the `metadata.tier` key/value shape in the EventDefinitionSchema Zod (already drafted in #219; just confirm it survived the rebase byte-for-byte).

**Blocks/Blocked by:** Blocks AUDIT-2, AUDIT-3, AUDIT-4, AUDIT-5. Blocked by: PR #219 rebased + merged.

**Acceptance:**
- Atlas migration applies cleanly on a database with existing pre-AUDIT-1 rows; existing rows show `tier='domain'`.
- Insert with `tier='audit', pool=null, direction=null` succeeds.
- Insert with `tier='audit', pool='events_change'` fails the CHECK at the DB layer.
- Insert with `tier='domain', pool=null` fails the CHECK at the DB layer.
- `(tier, status, occurred_at)` index present in the declared schema (not just intended via comment — see EVT-1 drift fix).
- Memory backend honors the same constraint at runtime (assertion in `insert()`).
- `just test-unit` and `just test-baseline` green.

**Out of scope:** Generator emission of `tier` (AUDIT-2); bus stamping logic (AUDIT-3); viewer queries (AUDIT-5).

**Skill/spec updates required:**
- `.claude/skills/events/SKILL.md` — update `domain_events` schema description; add the audit-tier semantics to the routing rules ("audit-tier rows have null pool/direction by construction").
- `docs/specs/EVT-1.md` — append a dated revision note linking forward to this plan; the "three indexes" claim becomes "four."

---

### AUDIT-2: Generator — emit `tier` in registry + codegen errors + tests

**Scope:** Update event YAML parser/codegen (the EVT-2 / EVT-3 layer):
- Default `tier: 'domain'` if absent in event YAML.
- Validate `tier: 'audit'` ⇒ `direction` and `pool` MUST be omitted in YAML; emit registry entry with `pool: null, direction: null, tier: 'audit'`.
- Validate `tier: 'domain'` ⇒ `direction` MUST be present (existing behavior, unchanged).
- Emit `tier` as a field on every registry entry (always populated, no defaults at runtime).
- Three templated hard-errors with exact wording:
  - `tier: 'audit'` + `pool: <X>` → `Event '<type>' is tier:audit; pool MUST be omitted (got '<X>'). Audit events have no pool. See ai-docs/specs/issue-242/plan.md §AUDIT-2.`
  - `tier: 'audit'` + `direction: <X>` → analogous.
  - Job YAML `triggers: [<audit_event>]` → `Job '<name>' triggers on audit-tier event '<type>'. Audit events are not bridge-eligible. Use a domain event, or remove the trigger.`
- Baseline refresh: registry output gains a `tier` field on every existing entry; refresh `test/baseline/` snapshots in this PR.

**Blocks/Blocked by:** Blocks AUDIT-3 (bus reads `meta.tier` from registry). Blocked by: AUDIT-1.

**Acceptance:**
- Codegen test asserts each of the three hard-errors fires with the exact templated message.
- Happy-path audit event (no `direction`/`pool` in YAML) generates a registry entry with `tier: 'audit', pool: null, direction: null`.
- Happy-path domain event (existing fixtures) generates registry entries with `tier: 'domain'` and unchanged `pool`/`direction`.
- `just test-baseline` green after baseline refresh; the diff is *only* the new `tier` field on every entry (verifies no other regen drift).
- `just test-unit` green.

**Out of scope:** Runtime bus changes (AUDIT-3); bridge guard (AUDIT-4).

**Skill/spec updates required:**
- `.claude/skills/events/SKILL.md` — document the three error paths; add `tier` to the YAML grammar reference.
- `docs/specs/EVT-3.md` (or wherever the codegen contract lives) — append the audit-tier validation rules.

---

### AUDIT-3: Runtime — TypedEventBus stamps `tier` + null routing for audit

**Scope:** Update the bus content builder. **Important:** `bus.ts` is *not* a Hygen template — it is generated as a TypeScript string by `src/cli/shared/event-codegen-generator.ts` (`buildBusContent`, ~L528-692). The string-builder produces `runtime/subsystems/events/generated/bus.ts` (current canonical version readable for reference). All edits to publish-time stamping happen in this string builder, not under `templates/`.
- When registry says `meta.tier === 'audit'`:
  - Stamp `metadata.pool = null, metadata.direction = null, metadata.tier = 'audit'` regardless of `opts.metadata` overrides (caller cannot override audit routing).
  - Skip the `meta.pool ?? meta.direction` resolution path entirely.
- When `meta.tier === 'domain'` (or undefined → defaulted): existing behavior, plus stamp `metadata.tier = 'domain'`.
- `metadata.version` and `metadata.tenantId` (multi-tenant case) stamping unchanged across both tiers.
- Update the `DrizzleEventBus.publish()` insert to write `tier` into the new column from `metadata.tier`. The `DomainEvent` shape in `runtime/subsystems/events/event-bus.protocol.ts` may need a `tier` field surfaced on the row insert (currently it derives `pool`/`direction` from `metadata` — same pattern, add `tier`).

**Blocks/Blocked by:** Blocks AUDIT-4 (guard reads `event.metadata.tier`). Blocked by: AUDIT-2.

**Acceptance:**
- Unit test publishes one audit event + one domain event; assert in `domain_events`:
  - Audit row: `tier='audit', pool=null, direction=null`.
  - Domain row: `tier='domain', pool` and `direction` populated as today.
- Caller passing `opts.metadata.pool = 'events_change'` for an audit event is *silently overridden* to null (with a debug-level log noting the override; callers should not be doing this, but it's not an error).
- `just test-unit` green.
- Smoke test (`just test-smoke`) green — generated app compiles + runs with the new bus.

**Out of scope:** Bridge guard (AUDIT-4); viewer (AUDIT-5).

**Skill/spec updates required:**
- `.claude/skills/events/SKILL.md` — add a "Non-obvious rule" entry: audit-tier routing fields are stamped by the bus, not honored from caller overrides.

---

### AUDIT-4: Runtime — Bridge dispatcher guard + WARN dedup + return-shape signal

> **Revision (2026-06-07) — guard fires only on genuine drift.** The original
> design below ("Position the guard at the **top** of `processEvent`, above the
> `lookupTriggers` call") warned for **every** audit-tier event. That assumed
> audit events reach the guard only via drift. In dogfood (swe-brain), audit-tier
> *lifecycle* events (`connection.created`, `connection.field_changed`, …) flow
> through the shared outbox routinely with **no** triggers — the benign case the
> acceptance criteria never covered. The unconditional guard turned every such
> event into a false-positive WARN claiming an out-of-band `bridge_trigger` row
> it never checked for.
>
> **Revised behaviour:** run `lookupTriggers` **first**, then branch on tier.
> `tier === 'audit'` *and* `triggers.length > 0` → genuine drift: WARN (now a
> verified claim, naming the offending trigger id) + `auditBlocked: 1`.
> `tier === 'audit'` *and* no triggers → benign: return zeros, **silent**.
> The drift signal is preserved; the false positive is gone. The SELECT-level
> `tier='audit'` filter was rejected — audit events still need the normal drain
> (`processed_at` + subscriber dispatch); only *bridge fanout* skips them.
>
> **Added acceptance:** audit event with **no** registered trigger → all zeros,
> `auditBlocked: 0`, no WARN, no inserts (the `connection.created` regression
> guard). See `ai-docs/specs/2026-06-07-bridge-audit-guard-false-positive.md`.
> The bullets below are the *original* (superseded) design, kept for provenance.

**Scope:** Update bridge outbox drain hook at `runtime/subsystems/bridge/bridge-outbox-drain-hook.ts` (path confirmed; matches dealbrain-v2). The hook already uses a once-per-process WARN dedup pattern (`warnedNullDirection`, L60/L86-97) for null-direction events — extend the same pattern for audit-tier blocks:
- **Position the guard at the top of `processEvent`** (above the existing `lookupTriggers` call at L72). If `event.metadata?.tier === 'audit'`, return `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 }` immediately. The existing trigger-lookup short-circuit at L73-75 (no triggers → return zeros) is the same shape; this just adds an earlier check.
- **Extend `BridgeOutboxDrainResult` with `auditBlocked: number`** in `runtime/subsystems/bridge/bridge.protocol.ts`. Same idiom as existing `delivered` / `dedupSkips` / `triggerCount`: per-event observability data piggybacked on the return. `0` for non-audit paths, `1` when the guard fires. Update the doc comment on the type to document the field. No in-memory state on the hook; no test-only accessor.
- **Per-`(event_type, process)` WARN dedup** via a private `Set<string>` on the hook (`warnedAuditTypes`). The existing `warnedNullDirection: boolean` is once-per-process; the audit case wants per-type granularity to surface drift in specific events without flooding logs across many event types.
- WARN message: `Bridge guard blocked audit-tier event '<type>' (event.id=<id>). Registry says this event is not bridge-eligible; a bridge_trigger row exists out-of-band. Investigate registry/runtime drift.`
- **Update `DrizzleEventBus.processBatch` (drain caller)** to include `auditBlocked` in any per-batch logging it already does. If the drain currently doesn't log aggregates, don't add aggregation now — the per-event return is sufficient and the WARN already surfaces individual hits.

**Why no `IObservability` read in this PR.** The composer port is strictly read-only today (`getPoolDepths`, `getRecentFailedJobs`, `getBridgeDeliveryHistogram`, `getRecentSyncRuns`, `getCursors` — see `observability.protocol.ts`); adding any new read for audit-blocks belongs in its own PR alongside a real consumer. Two clean follow-up paths if needed: (1) add `getBridgeAuditBlocks(windowHours)` on the bridge port + observability composer — read-side, fits the existing pattern; or (2) self-publish a `bridge.audit_blocked` event of `tier: 'audit'` from within the guard — the AUDIT-5 viewer surfaces it naturally with no new protocol. File AUDIT-6 if/when a consumer asks.

**Blocks/Blocked by:** Blocked by AUDIT-3.

**Acceptance:**
- Test inserts a `bridge_trigger` row for what is actually an audit event (out-of-band insert, simulating drift); publishes the audit event; asserts:
  - Zero `bridge_delivery` rows created.
  - Hook returns `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 }`.
  - WARN log emitted with the templated message.
- Repeat publish of the *same audit event type* in the same process: each call returns `auditBlocked: 1`; WARN does not re-fire (per-type dedup via `warnedAuditTypes` Set).
- Publish a *different audit event type* in the same process: returns `auditBlocked: 1`; WARN fires once for the new type.
- Domain event with a valid `bridge_trigger`: unchanged behavior — `auditBlocked: 0` on every result, no WARN.
- Domain event with no triggers: unchanged behavior — `auditBlocked: 0`, no WARN.
- `BridgeOutboxDrainResult` type doc updated to describe `auditBlocked`.
- `just test-unit` and `just test-smoke` green.

**Out of scope:** Viewer (AUDIT-5).

**Skill/spec updates required:**
- `.claude/skills/bridge/SKILL.md` — add a "Non-obvious rule" entry: bridge guard is defense-in-depth for audit events; the registry is the primary enforcement. Document the `bridge.audit_event_blocked` counter.
- `docs/adrs/ADR-023-event-to-job-bridge.md` (or wherever the bridge contract lives) — append a dated revision note covering the audit-tier guard.

---

### AUDIT-5: Observability viewer — `tier` filter + visual demotion

**Scope:** Update the observability events table API + UI:
- API: `GET /events?tier=domain|audit|all`, default `domain`. Filter is a SQL WHERE on the new `tier` column (uses the index from AUDIT-1).
- UI: tier badge per row (`domain` and `audit`); when `tier=all` is active, audit rows render visually de-emphasized (muted color or italic — pick one, document it).
- UI toggle: a checkbox or pill control that flips between `tier=domain` (default) and `tier=all`. No three-way toggle to a hypothetical `tier=audit-only` view — YAGNI; if someone needs it later, they can add it.
- Update the events viewer's count/pagination to respect the active filter.

**Blocks/Blocked by:** Blocked by AUDIT-1 (column needed for indexed filtering). Independent of AUDIT-2/3/4 in principle, but should land last because there's no audit data to view until AUDIT-3 ships.

**Acceptance:**
- API integration test: seeded mixed-tier rows; `?tier=domain` returns only domain rows; `?tier=audit` returns only audit rows; `?tier=all` returns both; default (no param) matches `?tier=domain`.
- UI smoke (browser-pilot): default page shows domain rows + tier badge; toggle reveals audit rows with muted styling; pagination total respects filter.
- Index from AUDIT-1 is used by the planner (verify with `EXPLAIN ANALYZE` or equivalent during impl; not a blocking AC, but worth a one-line check).
- `just test-smoke` green.

**Out of scope:** A separate audit-only inspection mode; per-tier metrics aggregation; cross-tier search.

**Skill/spec updates required:**
- `.claude/skills/observability/SKILL.md` — add the `tier` filter parameter to the viewer API documentation; note the default-domain behavior.

---

## 3. Sequencing

```
PR #219 rebase + merge          (unblocks contract — pre-work, not part of plan)
        ↓
AUDIT-1 (schema)                — must be first; loosens NOT NULL on pool/direction
        ↓
AUDIT-2 (generator)             — registry gains tier field; baseline refresh
        ↓
AUDIT-3 (bus stamping)          — runtime writes tier; rows now actually populated
        ↓
AUDIT-4 (bridge guard)          — defense-in-depth; depends on bus stamping
        ↓
AUDIT-5 (viewer)                — last; needs audit data flowing to be useful
```

AUDIT-5 *could* technically start in parallel with AUDIT-2 (API shape doesn't depend on bus stamping), but lands last because there's no audit data to view until AUDIT-3 ships.

## 4. Risks & open items

- **Baseline diff scope (AUDIT-2):** every existing registry entry gains a `tier` field, so the diff will touch every `test/baseline/` registry file. This is real, not noise. Reviewer should look for shape changes *beyond* the new field.
- **Dealbrain stamping divergence:** if dealbrain-v2's local `metadata.tier = 'audit'` stamping diverges from the schema locked in AUDIT-1 (different key, different value casing, etc.), they have a silent migration when AUDIT-3 ships. **Mitigation:** lock the Zod schema during the #219 rebase and confirm with dealbrain-v2 maintainer before AUDIT-3 starts.
- **Caller-override edge case (AUDIT-3):** silently overriding `opts.metadata.pool` for audit events is the right call (callers shouldn't be specifying it), but if a consumer relies on inspecting their `opts.metadata` post-publish they'll be confused. The debug log is the documented escape hatch; if a real consumer hits it, revisit and consider hard-erroring instead.
- **Bridge guard log volume (AUDIT-4):** per-`(event_type, process)` WARN dedup is a guess; if it logs too often in practice, downgrade to per-process or rate-limit. The counter is the canonical signal regardless.
- **No third-tier escape hatch:** Q3 closes off `tier: 'metric'` for now. If a real metric-shaped event arrives that doesn't fit either `domain` or `audit`, the answer is to widen this design, not to stuff it under `audit`. Surface it explicitly rather than letting `audit` become a junk drawer.
- **Drift signal is per-event, not externally aggregated (AUDIT-4):** `BridgeOutboxDrainResult.auditBlocked` rides on every drain-hook call; the WARN log surfaces individual hits. There is no cumulative counter and no `IObservability` read for audit-blocks in this epic — adding either belongs in a follow-up alongside a real consumer. File AUDIT-6 if production needs aggregate visibility (paths: `getBridgeAuditBlocks(windowHours)` on bridge + observability composer, or self-published `bridge.audit_blocked` audit-tier events surfaced by the AUDIT-5 viewer).

## 5. References

- PR #219: `feat(events): tier: audit — bridge-inert events for lifecycle/observability` (open, needs rebase)
- ADR-024 (events codegen formalization) and EVT-1..EVT-8 specs in `docs/specs/`
- ADR-023 (event-to-job bridge) in `docs/adrs/`
- Issue #226 plan in `ai-docs/specs/issue-226/plan.md` — pattern reference for this plan's shape
- Motivating consumer: dealbrain-v2's CRM sync convergence epic (their issue #50)
