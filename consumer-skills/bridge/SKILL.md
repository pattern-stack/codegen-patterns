---
name: bridge
description: Load when wiring the event-to-job bridge or declaring `jobTriggers(...)` in a project that ran `codegen subsystem install bridge`. Triggers include declaring which events start a job; deciding between an in-process subscriber, `eventFlow.publishAndStart`, and a bridge trigger; registering `BridgeModule.forRoot()`; ordering runs of one job per aggregate; or running `codegen events consumers <type>` to find who reacts to an event.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Event-to-Job Bridge

The bridge is the durable, typed, observable path from *"an event was published"* to *"a job was started"* in your
app. It is its own subsystem — the combiner between the `events` and `jobs` subsystems, owned by neither. You opt
into it with `codegen subsystem install bridge`, which vendors the runtime into
`<backend_src>/shared/subsystems/bridge/` (imported as `@shared/subsystems/bridge`) and adds a `bridge:` block to
`codegen.config.yaml`. Jobs are `@pattern-stack/jobs` jobs (the `jobs` skill).

## Mental model: three tiers of event-driven work

| Tier | Mechanism | Durability | Use for |
|---|---|---|---|
| 1. Subscribe | `@OnEvent('x.y')` / `IEventBus.subscribe()` in-process | None (at-most-once) | metrics, cache busts, logs |
| 2. Direct invoke | `eventFlow.publishAndStart(event, jobKey, input, opts)` | Yes (one transaction) | request-path work, the caller knows the job |
| 3. Bridge | `jobTriggers('<job key>', [{ event, map, when? }])` beside the job | Yes (outbox + ledger) | durable async fanout, decoupled authors |

Tier 2 and Tier 3 both flow through the bridge — the difference is *who declares the link*: the caller's
`publishAndStart`, or the job's `jobTriggers`.

**How a trigger runs (Tier 3).** When the events outbox drain claims a `domain_events` row it runs the bridge hook
inside that event's transaction. Per matched trigger: it writes a `bridge_delivery` row, skips the trigger if its job
is not registered in this process (`skipped` / `trigger_unregistered`) or its `when` is false (`skipped` /
`predicate_false`), otherwise starts your run with `JobStarter.start(jobKey, map(event), { tenantId, trigger:
'event' }, tx)` and marks the delivery `delivered` with the run's id. The run commits with the event; the jobs
executor's open-run sweep picks it up (about a second). There is no wrapper job and no reserved pool.

**The ledger is the source of truth.** `bridge_delivery` has `UNIQUE (event_id, trigger_id)`: it dedups an outbox
replay, and the case where a caller uses `publishAndStart` AND the job declares a matching trigger (Case B: the
facade pre-writes the delivery, the drain skips it). Exactly once comes from that key and the transaction, never
from a dedupe key or window.

## Install and wiring

```yaml
bridge:
  backend: drizzle       # 'drizzle' (production) or 'memory' (tests)
  multi_tenant: false    # true → the facade and the repo refuse a missing tenantId
```

The generated `SUBSYSTEM_MODULES` compose `BridgeModule.forRoot(...)` after `EventsModule` and `JobsEngineModule`;
do not register it by hand.

## Authoring triggers

```ts
// src/jobs/send-welcome-email.job.ts
import { defineJob, step } from '@pattern-stack/jobs';
import { jobTriggers } from '@shared/subsystems/bridge';   // package mode: '@pattern-stack/codegen/runtime/subsystems/bridge/index'

export const sendWelcomeEmail = defineJob({ key: 'send_welcome_email', /* input, output, limits, steps */ });

export const sendWelcomeEmailTriggers = jobTriggers('send_welcome_email', [
  { event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) },
  { event: 'contact_imported', map: (e) => ({ contactId: e.aggregateId }), when: (e) => e.payload.sendWelcome },
]);
```

- `codegen entity new` scans every `jobTriggers(...)` under the jobs directory into the generated bridge registry.
  An unknown event, an audit-tier event, or two triggers for one `(event, job)` pair is a generation error.
- `map` and `when` are **copied** into the registry: self-contained arrow functions, no imports or helpers.
- `map`'s result is the run's input, checked by the job's input schema at the start. A trigger that cannot start (its
  `map` throws, the input is refused, the job has no `limits`) fails alone: its delivery is `failed` with the error,
  and the event's other triggers and subscribers go ahead. It is not retried.
- A bridge-started job is started with no budget: give it `limits` (YAML jobs always have them).
- `dedupeKey: (e) => string` (optional): the start's dedupe key, so a run still open on it meets the job's
  `collision` (`join` / `queue` / `replace`) instead of running beside it.

## Ordering

The bridge starts one run per (event, trigger) and does not order runs by itself. To run a job one at a time per
aggregate, give the trigger a `dedupeKey: (e) => e.aggregateId` and the job `collision: 'queue'` (or `join` to fold
overlaps into the open run). A YAML job with `collision` or `dedupe` set gets one dedupe key per job, so a schedule
tick during a long run meets the collision. Exactly once per (event, trigger) is still the ledger's.

## When NOT to use the bridge

- The caller waits on the result: that is a use case, not a job.
- Only an in-process reaction is needed: Tier 1.
- One caller, one job, request path: Tier 2 (`publishAndStart`) — still exactly once with a matching trigger.

## Discovering fanout: `codegen events consumers <type>`

```bash
codegen events consumers user.created
```

Prints all three tiers with file:line citations (Tier 3 from the `jobTriggers` scan, Tier 2 from `publishAndStart`
call sites, Tier 1 from subscribers). An unknown event type warns but exits 0.

## Multi-tenancy

With `multi_tenant: true` (and `BridgeModule.forRoot({ multiTenant: true })`), `publishAndStart` and the delivery
repo throw `MissingTenantIdError` when `tenantId === undefined` (explicit `null` passes, for deliberate cross-tenant
work). The drain passes the event's `metadata.tenantId` to the start; none is `SYSTEM_TENANT`.

## Renaming or removing a trigger

A trigger's id is `<job key>#<index>`, stable across generations, so a replay resolves to the same ledger row.
Renaming the job key (or reordering its triggers) changes it; a delivery under the old id is not retried under the
new one. A trigger whose job is gone from this process is delivered as `skipped` / `trigger_unregistered`.

## Do not

- Do not collapse the three tiers into "the bridge is the only path."
- Do not declare triggers on the event side: they are the job's.
- Do not reference helpers, services or imports inside `map` / `when`.
- Do not skip `codegen entity new` after changing a trigger: the registry is generated.
- Do not lean on a dedupe key or window for the bridge's exactly-once; the ledger and the transaction own it.
- Do not drop `tenantId` when `multi_tenant: true`.

## Under `target.wiring: pattern-stack` (no Nest)

- `codegen subsystem install bridge` needs events (on drizzle) and jobs installed first; it vendors the Nest-free entry
  (`@shared/subsystems/bridge/core`, where `jobTriggers` lives) and no module, facade or tokens.
- `codegen entity new` writes the bridge registry, and the `events` system builds `BridgeOutboxDrainer` over the `jobs`
  system's starter and passes it to the bus: the drain starts each trigger's run in the event's own transaction, as
  under Nest. A trigger naming a job the app does not register stops the compose.
- `publishAndStart` (Tier 2) is Nest's `EventFlowService`; under pattern-stack, write the event and call
  `starter.start(…, tx)` in one transaction yourself.
