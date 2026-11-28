/**
 * Bridge subsystem — protocols (ports) — ADR-023 Phase 2, BRIDGE-2.
 *
 * Two interfaces:
 *
 *   - `IJobBridge`  — repo-shaped contract over the `bridge_delivery`
 *                     ledger. Backends: memory (BRIDGE-3), Drizzle
 *                     (BRIDGE-4). Consumed by the `EventFlowService`
 *                     facade for Case B pre-writes (BRIDGE-7) and by
 *                     observability; the outbox drain hook writes the same
 *                     table through the event's transaction.
 *
 *   - `IEventFlow`  — the developer-facing facade from ADR-023 §Decision 7.
 *                     Two verbs: `publish` and `publishAndStart`. All
 *                     request-path and fanout publishing should go through
 *                     this token rather than `IEventBus` / `TYPED_EVENT_BUS`
 *                     directly so reviewers can grep call sites and the
 *                     `codegen events consumers <type>` CLI (BRIDGE-9) can
 *                     index Tier 2 alongside Tier 3 triggers and Tier 1
 *                     subscribers.
 *
 * Both interfaces accept an optional last-arg `DrizzleTransaction` so
 * callers operating inside an existing transaction can thread it through
 * (the outbox drain's per-event tx, the facade's Case B pre-write).
 */
import type { InferInsertModel } from 'drizzle-orm';

import type { DrizzleTransaction, DomainEvent } from '../events/event-bus.protocol';
import type {
  EventOfType,
  EventTypeName,
} from '../events/event-registry';

import type {
  BridgeDeliveryRecord,
  bridgeDelivery,
} from './bridge-delivery.schema';

// ============================================================================
// IJobBridge — bridge_delivery ledger repo
// ============================================================================

/**
 * Insert payload for `IJobBridge.insertDelivery`. Derived from the
 * Drizzle schema so the contract stays in sync with the table — adding a
 * column to `bridge_delivery` propagates to every backend without manual
 * sync. `id`, `attemptedAt` carry DB defaults; `userRunId`,
 * `skipReason`, `error`, `tenantId`, `deliveredAt` are nullable per BRIDGE-1.
 */
export type BridgeDeliveryInsert = InferInsertModel<typeof bridgeDelivery>;

/**
 * Status histogram returned by IJobBridge.getStatusHistogram.
 *
 * Keys match the bridge_delivery_status enum values (bridge-delivery.schema.ts).
 * Missing statuses in the underlying result set are zero-filled so consumers
 * can render a fixed 4-row chart without branching.
 *
 * PHASE 1: plain counts only. The time-bucketed variant (per-interval series
 * for a sparkline / timeline chart) belongs to the semantic query layer
 * (query-surface over the generated semantic model, ADR-045) and must NOT be
 * added to this protocol. If a consumer needs buckets, that's a signal to
 * route the query through the semantic layer, not to grow the core contract.
 */
export type StatusHistogram = {
  pending: number;
  delivered: number;
  skipped: number;
  failed: number;
};

export interface IJobBridge {
  /**
   * Insert a `bridge_delivery` row.
   *
   * **Throws on `UNIQUE (event_id, trigger_id)` conflict.** Callers that
   * expect collisions (the outbox drain hitting a facade-eager pre-write,
   * the drain re-claiming after a crash) should catch the conflict and
   * skip — see ADR-023 §`publishAndStart` + existing `triggers:` collision
   * and the BRIDGE-4 spec for the recommended `INSERT … ON CONFLICT … DO
   * NOTHING RETURNING id` shape that turns the throw into an empty result.
   */
  insertDelivery(
    row: BridgeDeliveryInsert,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * The outbox drain's claim on one `(event_id, trigger_id)`: inserts its `pending` row and returns the row's id, or
   * `null` when the pair already has one (an outbox replay, or `publishAndStart`'s Case B pre-write). Every backend
   * answers a duplicate the same way, by `null`, never a throw. Asserts the tenant as `insertDelivery` does (a
   * multi-tenant bridge refuses an event with no tenant, `MissingTenantIdError`).
   */
  claimDelivery(
    row: Pick<BridgeDeliveryInsert, 'eventId' | 'triggerId' | 'tenantId'>,
    tx?: DrizzleTransaction,
  ): Promise<string | null>;

  /**
   * Lookup a delivery by its idempotency key. Returns `null` when no row
   * matches. Used in tests / dashboards for the canonical (event, trigger)
   * lookup.
   */
  findDelivery(
    eventId: string,
    triggerId: string,
  ): Promise<BridgeDeliveryRecord | null>;

  /**
   * Lookup a delivery by primary key. Drizzle backend (BRIDGE-4):
   * `SELECT … WHERE id = ? LIMIT 1`. Memory backend (BRIDGE-3): linear
   * scan (small N). Returns `null` when no row matches.
   */
  findDeliveryById(id: string): Promise<BridgeDeliveryRecord | null>;

  /**
   * Transition `pending` → `delivered`, populating `user_run_id` and
   * `delivered_at`. (The outbox drain hook writes the same transition
   * inline, in the event's transaction; JOBS-3.)
   */
  markDelivered(
    id: string,
    userRunId: string,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * Transition `pending` → `skipped`, populating `skip_reason`: the
   * trigger's `when:` predicate returned `false`, or its job is not
   * registered (rename scenario from ADR-023 §Consequences).
   */
  markSkipped(
    id: string,
    reason: string,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * Transition `pending` → `failed`, populating `error`; surfaces in ops
   * dashboards via the `idx_bridge_delivery_status` partial index.
   */
  markFailed(
    id: string,
    error: Record<string, unknown>,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * Count bridge_delivery rows by status, filtered to rows where
   * attemptedAt >= (now - windowHours) and (optionally) tenantId matches.
   *
   * Tenant semantics:
   *   - tenantId omitted or explicit undefined: no tenant filter (counts across
   *     all tenants — appropriate for framework-internal admin dashboards).
   *   - tenantId === null: match rows where tenant_id IS NULL (cross-tenant
   *     housekeeping deliveries).
   *   - tenantId === '<string>': match rows where tenant_id = '<string>'.
   *
   * Returns all-zero StatusHistogram when no rows match — never empty object,
   * never undefined. Consumers rely on fixed keys for rendering.
   *
   * `windowHours` must be positive; implementations throw `RangeError` for
   * `windowHours <= 0`. No upper bound is enforced — the caller is
   * responsible for choosing a sensible window.
   *
   * Unlike the write methods on this port, this read intentionally does NOT
   * invoke `assertTenantId`: `tenantId === undefined` is a supported
   * cross-tenant admin view, not a policy violation.
   *
   * PHASE 1: plain counts only. Do NOT add a bucketing / time-series variant
   * to this method or the protocol — see StatusHistogram JSDoc.
   */
  getStatusHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram>;
}

// ============================================================================
// IEventFlow — developer-facing facade (ADR-023 §Decision 7)
// ============================================================================

/**
 * Caller-supplied options for `IEventFlow.publishAndStart`.
 *
 * `tenantId`: explicit `null` opts into cross-tenant work (the run is
 * `SYSTEM_TENANT`'s); `undefined` throws `MissingTenantIdError` when
 * `BridgeModule` is configured with `multiTenant: true`. (ADR-022's
 * `parentRunId` is gone in JOBS-3: a child run is a step's `children`.)
 */
export interface PublishAndStartOptions {
  /** The run's tenant; none is `SYSTEM_TENANT` (JOBS-3). */
  tenantId?: string | null;
  /** The run's dedupe key: an open run on it answers the start (`@pattern-stack/jobs`' collision rules). */
  dedupeKey?: string;
}

/**
 * Result of `IEventFlow.publishAndStart`. The facade returns the
 * eagerly-started user run's id so the caller can subscribe to its
 * completion or correlate with its own request id.
 */
export interface PublishAndStartResult {
  runId: string;
}

export interface IEventFlow {
  /**
   * Tier 1 + Tier 3 — plain publish.
   *
   * Writes the event to the outbox (or in-memory bus, depending on the
   * backend). Bridge triggers fire asynchronously (via
   * `jobTriggers(...)`); in-process `IEventBus.subscribe` handlers
   * fire in-call. Returns when the outbox row is committed.
   *
   * Delegates to `IEventBus.publish` under the hood.
   *
   * **Note on signature:** ADR-023 §Decision 7 sketches the verb as
   * `publish<T extends EventType>(event: TypedEvent<T>)`. The actual
   * generated types are `EventTypeName` and `EventOfType<T>` (see
   * `runtime/subsystems/events/generated/types.ts`); we use those here so
   * the contract typechecks against the real codegen output. The verb
   * shape and behaviour are unchanged.
   */
  publish<T extends EventTypeName>(
    event: EventOfType<T>,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * Tier 2 + Tier 3 + Tier 1 — publish + eagerly start a specific named
   * job.
   *
   * Behaviour:
   *   1. Writes the event to the outbox (so bridge triggers and Tier 1
   *      subscribers fire as normal).
   *   2. Starts the user job with `JobStarter.start(jobKey, input, opts, tx)`
   *      (`@pattern-stack/jobs`' `startRun`, in the same transaction).
   *   3. **Case B dedup** — if the (event, jobKey) pair has a declared
   *      `jobTriggers(...)` entry, the facade pre-writes a
   *      `bridge_delivery(status='delivered', user_run_id=<eagerRunId>)`
   *      row in the same transaction as the start. The
   *      drain's later `INSERT … ON CONFLICT (event_id, trigger_id) DO
   *      NOTHING` then sees the existing row and skips that trigger while
   *      still spawning any other triggers for the same event.
   *
   * Use when the caller needs the job enqueued before returning to the
   * user (request-path, within-transaction durability). For pure async
   * fanout where Tier 3 alone suffices, use `publish` instead.
   *
   * **Same-tx invariant** (BRIDGE-7): the outbox insert, the
   * run's insert, and the Case B `bridge_delivery`
   * pre-write must all share a transaction. A crash between any two
   * leaves the system inconsistent (e.g. event published but no eager
   * run, or eager run with no Case B dedup row → drain double-spawns).
   *
   * **Note on signature:** ADR-023 §Decision 7 sketches `JobType` /
   * `JobInputOf<J>` parameters; `JobStarter.start` takes `(jobKey: string,
   * input: unknown, …)` and the job's own input schema checks the input at
   * the start. A generated job-key union is a follow-up.
   */
  publishAndStart<T extends EventTypeName>(
    event: EventOfType<T>,
    jobKey: string,
    input: unknown,
    opts?: PublishAndStartOptions,
  ): Promise<PublishAndStartResult>;
}

// ============================================================================
// bridgeRegistry — emitted by codegen (BRIDGE-6), consumed by the drain hook
// (BRIDGE-4) and the EventFlow facade (BRIDGE-7).
// ============================================================================

/**
 * One entry in the `bridgeRegistry`. Generated from a user job's
 * `jobTriggers('<job key>', [...])` declaration (BRIDGE-6, JOBS-3), and from YAML jobs (RFC-0005).
 *
 * The `T extends EventTypeName` parameter is what gives `map`/`when`
 * callbacks compile-time access to the typed payload via `EventOfType<T>`.
 * Codegen emits one entry per (job, trigger-index) pair, so `triggerId` is
 * stable across re-runs.
 *
 * `triggerId` shape: `<jobKey>#<triggerIndex>`. Forms the second half of
 * the `bridge_delivery (event_id, trigger_id)` UNIQUE idempotency key.
 *
 * `map` is required and returns the input payload the job's run starts with
 * (`JobStarter.start(jobKey, input, ...)`) — typed as `unknown` here
 * because the registry is event-keyed, not job-keyed (one event can fan
 * out to N jobs with N input shapes).
 *
 * `when` is optional. When provided and the predicate returns `false` at
 * drain time, the drain records the delivery as
 * `skipped` with `skip_reason='predicate_false'` rather than spawning the
 * user job (ADR-023 §Decision 6).
 */
export interface BridgeTriggerEntry<
  T extends EventTypeName = EventTypeName,
> {
  triggerId: string;
  /** The `defineJob` key the trigger starts. */
  jobKey: string;
  map: (event: EventOfType<T>) => unknown;
  when?: (event: EventOfType<T>) => boolean;
  /** The start's dedupe key (see `JobTriggerDeclaration.dedupeKey`). */
  dedupeKey?: (event: EventOfType<T>) => string;
}

/**
 * Codegen-emitted registry — `Record<EventTypeName, BridgeTriggerEntry[]>`.
 * Per-event-type ordered array of triggers (declaration order across
 * handler files, deterministic across codegens so `triggerId` indices stay
 * stable).
 *
 * The mapped-type form (`{ [T in EventTypeName]?: BridgeTriggerEntry<T>[] }`)
 * gives each entry's `map`/`when` callbacks the right `EventOfType<T>`
 * narrowing under indexed access.
 */
export type BridgeRegistry = {
  [T in EventTypeName]?: BridgeTriggerEntry<T>[];
};


// ============================================================================
// IBridgeOutboxDrainHook — port the events outbox drain calls per event
// ============================================================================

/**
 * Result of one drain-hook invocation, returned for observability + tests.
 *
 * `delivered`: number of triggers whose run the hook started for this event
 * (a `bridge_delivery` row marked `delivered`, post-`ON CONFLICT DO NOTHING`).
 *
 * `dedupSkips`: number of triggers whose `bridge_delivery` insert tripped
 * `UNIQUE (event_id, trigger_id)` and was skipped (Case B from ADR-023's
 * facade-eager pre-write, or replay of a previous drain attempt). These
 * are not failures — they're the dedup mechanism doing its job.
 *
 * `triggerCount`: total triggers matched in the registry for this event;
 * `triggerCount === delivered + dedupSkips + skipped`, where a skipped
 * trigger's `when` was false or its job is not registered here (its row is
 * marked `skipped`).
 *
 * `auditBlocked`: number of audit-tier events the dispatcher refused to fan
 * out *because they had a trigger registered against them*. Audit-tier events
 * are not bridge-eligible; codegen errors block the registry from listing them
 * as triggers, so a non-zero value here indicates genuine registry/runtime
 * drift (an out-of-band `bridge_trigger` insert, version skew during deploy).
 * A benign audit-tier event — one with no matched trigger, the common case for
 * lifecycle events sharing the outbox — returns `0` and produces no log.
 * Per-event: `0` when the guard does not fire (including benign audit events),
 * `1` when it fires on drift. Add it to per-batch logging if your drain caller
 * aggregates results. See ai-docs/specs/issue-242/plan.md §AUDIT-4.
 */
export interface BridgeOutboxDrainResult {
  delivered: number;
  dedupSkips: number;
  triggerCount: number;
  auditBlocked: number;
}

/**
 * Port the events outbox drain (EVT-4 / `DrizzleEventBus.processBatch`)
 * calls once per drained event, INSIDE the per-event transaction
 * (BRIDGE-4). Implemented by `BridgeOutboxDrainHook` in the bridge
 * subsystem; injected as `@Optional()` into `DrizzleEventBus` so projects
 * that haven't installed the bridge subsystem keep the EVT-4 baseline.
 *
 * Why a port and not direct schema imports inside the events subsystem:
 *   - Keeps the events subsystem free of any knowledge of bridge_delivery
 *     and the jobs engine; the layering inversion that ADR-023
 *     names ("the drain must know about bridge") is captured in this one
 *     port, not strewn across every bridge column the drain touches.
 *   - Tests can mock the port and assert call-shape without spinning up
 *     the full bridge module.
 *   - `BridgeModule.forRoot()` (BRIDGE-8) wires the implementation; in
 *     non-bridge consumers the token is undefined and the drain skips
 *     the bridge block entirely. ADR-023 §Outbox drain atomicity is
 *     preserved either way (the per-event tx still wraps `processed_at`).
 */
export interface IBridgeOutboxDrainHook {
  /**
   * Process one drained event's bridge fanout. Called inside the drain's
   * per-event transaction; for every matched trigger the hook writes a
   * `bridge_delivery` row and starts the trigger's run via the supplied `tx`
   * (JOBS-3).
   *
   * Behaviour:
   *   0. **Audit-tier guard (defense-in-depth).** Runs *after* the registry
   *      lookup (step 1). If `event.metadata.tier === 'audit'` AND a trigger
   *      is registered against the type (genuine drift — AUDIT-2 should have
   *      prevented it), returns
   *      `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 }`
   *      and logs a per-`(event_type, process)` WARN naming the offending
   *      trigger id(s). If the audit event has *no* matched trigger (the
   *      common, benign case — lifecycle events sharing the outbox), returns
   *      all zeros (`auditBlocked: 0`) silently. The codegen-side validator
   *      (AUDIT-2) is the primary enforcement; this guard catches out-of-band
   *      `bridge_trigger` inserts and version skew. See
   *      ai-docs/specs/issue-242/plan.md §AUDIT-4.
   *   1. Looks up `bridgeRegistry[event.type]`. No matches → returns
   *      `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 0 }`;
   *      the drain proceeds to dispatch user subscribers + stamp
   *      `processed_at`.
   *   2. For each matched trigger:
   *      - `IJobBridge.claimDelivery` (`INSERT … ON CONFLICT (event_id,
   *        trigger_id) DO NOTHING RETURNING id`, the tenant asserted). `null`
   *        ⇒ Case B / replay collision; start nothing for this trigger;
   *        sibling triggers still fire normally.
   *      - Its job not registered here ⇒ mark `skipped`
   *        (`trigger_unregistered`); its `when` false ⇒ mark `skipped`
   *        (`predicate_false`).
   *      - Otherwise `JobStarter.start(jobKey, map(event), { tenantId,
   *        trigger: 'event' }, tx)` and mark the row `delivered` with the
   *        run's id. The jobs executor's open-run sweep finds the run once
   *        the drain commits.
   *   3. Returns the counts for observability.
   *
   * A trigger that fails through its own fault (its `when`, `map` or
   * `dedupeKey` throws, or the engine refuses its start) fails alone: its
   * start runs in a savepoint, its delivery is marked `failed`, and the
   * event and its other triggers commit. Any other error (a deadlock, a
   * timeout, a dropped connection) is thrown: it aborts the per-event tx —
   * bridge inserts roll back, the `processed_at` stamp is not made, and the
   * event re-claims on the next drain cycle. A missing registry entry is
   * handled inline and does not throw.
   */
  processEvent(
    event: DomainEvent,
    tx: DrizzleTransaction,
  ): Promise<BridgeOutboxDrainResult>;
}

// ============================================================================
// jobTriggers — how a job declares the events that start it (JOBS-3)
// ============================================================================

/** One trigger a job declares: the event, the job input mapped from it, and an optional predicate. */
export interface JobTriggerDeclaration<T extends EventTypeName = EventTypeName> {
  event: T;
  map: (event: EventOfType<T>) => unknown;
  when?: (event: EventOfType<T>) => boolean;
  /**
   * The start's dedupe key: a run of the job still open on this key (per tenant) meets the job's `collision` (`join`,
   * `queue`, `replace`) instead of a second concurrent run — how a scheduled job keeps an overrun from overlapping.
   * Exactly once per (event, trigger) is still the ledger's and the transaction's, never this key's.
   */
  dedupeKey?: (event: EventOfType<T>) => string;
}

/**
 * Declares the events that start a job, beside its `defineJob`:
 *
 * ```ts
 * export const reindex = defineJob({ key: 'document.reindex', … });
 * export const reindexTriggers = jobTriggers('document.reindex', [
 *   { event: 'document_updated', map: (e) => ({ documentId: e.aggregateId }) },
 * ]);
 * ```
 *
 * Codegen reads these calls from source (BRIDGE-6) into the generated `bridgeRegistry`, so `map` and `when` must be
 * self-contained arrow functions (they are copied, not imported). At runtime it is the identity.
 */
export function jobTriggers<const T extends readonly JobTriggerDeclaration[]>(jobKey: string, triggers: T): T {
  void jobKey;
  return triggers;
}
