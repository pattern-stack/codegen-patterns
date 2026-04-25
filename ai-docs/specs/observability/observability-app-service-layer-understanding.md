# Understanding — Cross-subsystem composition layer (where observability lives)

## The question

Does the codebase have precedent for cross-subsystem composition at the consumer/application level, and if so, where does it live? Should observability be:
- (a) Framework-level composer in `runtime/`, ADR'd as a new layer
- (b) "5th infrastructure subsystem" per the epic's original framing
- (c) Consumer-level in `packages/api/`

## Answer

**Yes, direct precedent exists — and it lives in framework `runtime/`, not consumer code.** The canonical precedent is **`BridgeModule` + `EventFlowService`**. Observability should mirror bridge's layering but not its framing.

**Recommendation: option (a) — framework-level composer with ADR**, explicitly distinguished from ADR-008 "infrastructure subsystems with backends."

## The precedent: bridge as combiner

### `runtime/subsystems/bridge/event-flow.service.ts`
`@Injectable` facade that constructor-injects `DRIZZLE` + `EVENT_BUS` (events subsystem) + `JOB_ORCHESTRATOR` (jobs subsystem) + `BRIDGE_DELIVERY_REPO` + `BRIDGE_REGISTRY` and composes them into two verbs (`publish`, `publishAndStart`). Literally a constructor-injected cross-subsystem composer.

### `runtime/subsystems/bridge/bridge.module.ts`
Module docstring is explicit:
> "The bridge is the formalized seam between events (ADR-024) and jobs (ADR-022). It is owned by neither subsystem and consumes their tokens via DI. `BridgeModule` is the **combiner** — neither `EventsModule` nor `JobsDomainModule` know about it."

### `runtime/subsystems/bridge/bridge.protocol.ts`
Defines `IEventFlow` as *"the developer-facing facade from ADR-023 §Decision 7."*

## Naming convention (what the repo actually uses)

- Class: `EventFlowService`
- Protocol: `IEventFlow` (plus `IJobBridge` for the ledger underneath)
- Token: `EVENT_FLOW`
- Module: `BridgeModule` — **the subsystem name is the *seam* being formalized, not a concatenation of what it combines**

**No `ApplicationService`, `Coordinator`, `Facade`, or `QueryService` naming exists anywhere in `runtime/`.** The closest vocabulary is "facade" (used in bridge comments) or plain `<Domain>Service`.

## What generalizes from bridge → observability

- Structural pattern: named subsystem directory that owns the composer; module declares itself the "combiner"; service injects tokens from sibling subsystems; no sibling knows about the composer
- DI-only wiring (no sibling `imports`; consumer orders the modules; `global: true`)
- Protocol + token + service class trio
- Lives in `runtime/subsystems/<name>/`, not consumer code

## What does NOT generalize

- `EventFlowService` is a **write orchestrator** bound by transactional-outbox semantics — its load-bearing method opens a `db.transaction` and threads `tx` across three subsystems atomically. Observability is read-only; no transaction, no idempotency ledger, no pre-write dedup.
- Bridge owns its own durable state (`bridge_delivery` ledger, schema, drain hook, reserved pools). Observability owns no state — it reads state that already lives in jobs / bridge / sync / events tables. **No backend-swappability question**: the backend is "whatever the underlying subsystems use."
- Bridge was promoted to a full subsystem because it needed schema + handler + drain hook + reserved pools + multi-tenancy gate. Observability has none of those.

**Conclusion:** borrow bridge's *layering* (framework-level combiner in `runtime/subsystems/<name>/`, protocol + service + module, `global: true`) but not its *framing* (subsystem-with-backends).

## Why (b) and (c) are wrong

- **(b) "5th subsystem"** is misleading because `codegen subsystem install observability` would promise a backend choice there isn't.
- **(c) "Consumer composes it"** is wrong for this repo: consumers here don't have a place to author cross-subsystem services — the framework ships `EventFlowService` precisely so consumers don't re-compose events + jobs themselves. Forcing observability to consumer-level would break the symmetry with bridge.

## Relevant code

```
runtime/subsystems/bridge/
├── bridge.module.ts              ← "combiner" docstring; canonical precedent
├── event-flow.service.ts         ← cross-subsystem composer
├── bridge.protocol.ts            ← IEventFlow / IJobBridge
└── bridge.tokens.ts              ← EVENT_FLOW, BRIDGE_*
runtime/subsystems/sync/
└── sync.module.ts                ← cursor store lives HERE (not its own subsystem)
runtime/base-classes/base-service.ts   ← weak precedent: injects IEventBus for lifecycle emission
docs/CONSUMER-SETUP.md             ← consumer shape; no app-service layer defined
```

## Existing patterns

- **"Combiner subsystem" (bridge).** Framework-level `runtime/subsystems/<name>/` whose module explicitly disclaims ownership by siblings and composes their tokens via DI. `global: true`. Consumer orders imports. **This is the pattern observability should mirror.**
- **Protocol + Service + Token trio.** `IEventFlow` / `EventFlowService` / `EVENT_FLOW`. No `ApplicationService` naming.
- **Single-subsystem orchestrator (sync).** `ExecuteSyncUseCase` is registered by the consumer feature module to avoid premature DI resolution — single-subsystem, not a cross-subsystem precedent.

## Load-bearing decisions & open questions

- ADR-023 (bridge) and ADR-024 (events) are referenced in bridge source comments but need direct reading to confirm whether they formalize the "combiner subsystem" shape explicitly. Recommend the observability ADR author read ADR-008 and ADR-023 carefully for composer-vs-infra distinction before writing.
- The epic mentions "cursor" as a subsystem observability reads from. **Correction: cursor is NOT its own subsystem** — it lives as `sync-cursor-store` inside sync. Observability reads cursors through sync's protocols.
- No `ApplicationService` / `application-service` naming exists in the codebase based on representative file reads; introducing it would create new vocabulary for no reason when "combiner subsystem" is already the pattern.
