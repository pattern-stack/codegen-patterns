# Bridge audit-tier guard — fire only on genuine drift Spec

Revises AUDIT-4 (`ai-docs/specs/issue-242/plan.md`). Dogfood discovery from swe-brain.

## Overview

`BridgeOutboxDrainHook.processEvent` emits a false-positive WARN for every
audit-tier event that flows through the outbox. The warning claims a
`bridge_trigger` row "exists out-of-band" — a registry/runtime-drift condition it
never actually checks. Audit-tier lifecycle events (`connection.created`,
`connection.field_changed`, …) share the outbox with domain events and carry **no**
triggers; the drain scans every row, hits them, and warns once per type. This
delivers the fix: the guard fires **only** when an audit event genuinely has a
registered trigger (the real drift), and is silent for the benign
shared-outbox case.

## Root cause (confirmed against source)

`runtime/subsystems/bridge/bridge-outbox-drain-hook.ts:90-98`:

```ts
if (event.metadata?.['tier'] === 'audit') {
  this.warnAuditBlockedOnce(event);          // fires unconditionally
  return { delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 };
}
const triggers = this.lookupTriggers(event.type);   // L100 — never reached for audit
```

The guard returns **before** `lookupTriggers` runs, so it cannot know whether a
trigger exists. Yet `warnAuditBlockedOnce` (L250-258) prints
`"…a bridge_trigger row exists out-of-band. Investigate registry/runtime drift."`
— asserting the very fact it skipped checking.

This faithfully implements the **original** AUDIT-4 design
(`issue-242/plan.md:115`): *"Position the guard at the top of `processEvent`
(above the existing `lookupTriggers` call)."* That design assumed audit events
reach the guard only via drift. In practice, audit-tier lifecycle events flow
through the shared outbox continuously — the benign case the spec assumed away.

## Contract safety

`processEvent`'s return value is **discarded** at
`runtime/subsystems/events/event-bus.drizzle-backend.ts:635`
(`await this.bridgeHook.processEvent(event, tx);` — result unused).
`auditBlocked` has **zero runtime consumers**; it is observability/doc surface
only (grep confirms: only the protocol doc + an event-bus test stub reference
it). Changing benign-audit from `auditBlocked:1` to `auditBlocked:0` is safe.

## The fix — reorder so the guard signals genuine drift

In `processEvent`, look up triggers **first**, then branch on audit tier:

- `tier === 'audit'` **and** `triggers.length > 0` → **genuine drift**: an audit
  event that actually has a registered trigger (codegen-side AUDIT-2 validation
  should have prevented this). Warn (the message is now *true*) and return
  `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 }`. No fanout
  rows written. Enrich the WARN with the offending trigger id(s) for debugging.
- `tier === 'audit'` **and** `triggers.length === 0` → **benign** shared-outbox
  case. Return all-zeros (`auditBlocked: 0`), **silent**. ← kills the
  `connection.created` / `connection.field_changed` warning.
- Non-audit → unchanged.

**Rejected alternative:** filtering `tier='audit'` at the outbox SELECT in the
event bus. Wrong blast radius — audit events still need the normal drain
(`processed_at` stamp + subscriber dispatch); only *bridge fanout* must skip
them. The reorder keeps the change scoped to the one hook.

The per-`(event_type, process)` WARN dedup (`warnedAuditTypes` Set) and the
once-per-process null-direction warning are preserved.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge-outbox-drain-hook.ts` | modify | Reorder: `lookupTriggers` before the audit branch; guard fires only when `triggers.length > 0`; benign audit returns zeros silently; enrich drift WARN with trigger id(s). |
| `src/__tests__/runtime/subsystems/bridge-outbox-drain-hook.spec.ts` | modify | Fix the two tests that encode the bug; add the benign-audit regression test. |
| `runtime/subsystems/bridge/bridge.protocol.ts` | modify | Update `auditBlocked` field doc + `IBridgeOutboxDrainHook` step-0 behaviour doc to the refined semantics. |
| `ai-docs/specs/issue-242/plan.md` | modify | Dated revision note on AUDIT-4 (decision revisited on grounds that no longer apply). |
| `.claude/skills/bridge/SKILL.md` | modify | (a) Correct the "Audit-tier guard" section (L75-85) — it encodes the same bug ("at the very top of the method", "reaching the guard is a drift signal: an out-of-band `bridge_trigger` row exists"). (b) Add a non-obvious rule for reacting to lifecycle events. |

## Implementation steps

1. **Hook reorder** (`bridge-outbox-drain-hook.ts`):
   - Move `const triggers = this.lookupTriggers(event.type)` above the audit
     branch.
   - Replace the `tier === 'audit'` early-return with:
     `if (event.metadata?.['tier'] === 'audit') { if (triggers.length > 0) { this.warnAuditBlockedOnce(event, triggers); return { …, triggerCount: 0, auditBlocked: 1 }; } return { …all zeros }; }`
   - Keep the existing `triggers.length === 0 → zeros` short-circuit for the
     non-audit path (now naturally after the audit branch).
   - Update `warnAuditBlockedOnce(event, triggers)` to include the offending
     `triggerId`(s) in the message. Update the leading comment block (L85-89) to
     describe the refined "drift = audit + registered trigger" semantics.

2. **Tests** (`bridge-outbox-drain-hook.spec.ts`):
   - `'dedups WARN per event type within a single process'` (L376-389) and
     `'emits a fresh WARN when a different audit event type is seen'` (L391-408):
     currently construct the hook with an **empty** registry yet assert
     `auditBlocked:1` + WARN. Rewrite to register a trigger against the audit
     event type(s) so the drift (and therefore the WARN) is real.
   - Keep `'blocks fanout when an audit event reaches an out-of-band trigger'`
     (L343) — already a drift scenario; assert the message now contains the
     trigger id.
   - **Add** `'stays silent for an audit event with no registered trigger
     (benign shared-outbox case)'`: empty registry + audit event → result
     `{ delivered:0, dedupSkips:0, triggerCount:0, auditBlocked:0 }`, `calls`
     length 0, `warnSpy` not called. This is the `connection.created` regression
     guard.

3. **Protocol doc** (`bridge.protocol.ts`): rewrite the `auditBlocked` field
   comment (~L337-344) and `IBridgeOutboxDrainHook` step 0 (~L379-386) to:
   guard fires (`auditBlocked:1` + per-type WARN) **only** when an audit event
   has a registered trigger; benign audit events with no trigger return zeros
   silently and produce no log.

4. **Spec revision** (`issue-242/plan.md` AUDIT-4): add a dated revision note —
   the top-of-function guard (L115) produced false positives because audit-tier
   lifecycle events flow through the shared outbox routinely (benign case the
   acceptance criteria omitted); guard refined to fire only on
   `audit + registered trigger`; add the new benign-audit acceptance criterion.

5. **Bridge skill** (`.claude/skills/bridge/SKILL.md`):
   - Correct the "Audit-tier guard (defense-in-depth)" section (L75-85): it
     currently states the guard sits "at the very top of the method" (L78) and
     that "Reaching the guard is a drift signal: an out-of-band `bridge_trigger`
     row exists" (L81) — both now false. Rewrite to: the guard runs **after**
     trigger lookup and fires (`auditBlocked:1` + per-type WARN) **only** when an
     audit event has a registered trigger; benign audit events (the common case
     — lifecycle events sharing the outbox) return zeros silently.
   - Add a non-obvious rule (the dogfood lesson): **to make a workflow/directive
     react to a lifecycle moment (e.g. "a connection was created"), emit a typed
     domain change-fact** — declare it on the entity `events:` block (the
     `message_created` path) / EMIT-CHANGES seam — **never make the audit
     lifecycle event bridge-eligible.** The audit tier stays inert by design;
     promoting it would defeat the AUDIT-2 invariant and re-introduce exactly the
     false-positive class this fix removed.

## Forward pointer (not implemented here)

If swe-brain (or any consumer) wants a directive to fire on connection lifecycle,
the consumer declares a domain change event on its `connection` entity
(`events:` / EMIT-CHANGES) — a bridge-eligible domain-tier fact distinct from the
inert `connection.created` audit event. That is the consumer's product decision
and lives in the consumer repo, not in this codegen fix. Captured as a bridge
SKILL.md rule so the next person hits the answer, not the rake.

## Acceptance

- Audit event + **registered trigger** → `auditBlocked:1`, no fanout rows, WARN
  fires once per type, message includes the trigger id.
- Audit event + **no trigger** → all-zeros, **no WARN**, no inserts.
- Domain event (valid triggers / no triggers) → unchanged.
- `just test-unit` green.

## Out of scope

- swe-brain consumer side (stops once codegen is published + consumed).
- Outbox SELECT changes / event-bus drain changes.
- Any `IObservability` aggregate read for audit blocks (still AUDIT-6 territory).
