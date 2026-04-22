/**
 * Bridge subsystem — protocols (ports) — ADR-023 Phase 2, BRIDGE-2.
 *
 * Two interfaces:
 *
 *   - `IJobBridge`  — repo-shaped contract over the `bridge_delivery`
 *                     ledger. Backends: memory (BRIDGE-3), Drizzle
 *                     (BRIDGE-4). Consumed by the framework
 *                     `BridgeDeliveryHandler` (BRIDGE-5), the modified
 *                     outbox drain (BRIDGE-4), and the `EventFlowService`
 *                     facade for Case B pre-writes (BRIDGE-7).
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

import type { DrizzleTransaction } from '../events/event-bus.protocol';
import type {
  EventOfType,
  EventTypeName,
} from '../events/generated/types';

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
 * sync. `id`, `attemptedAt` carry DB defaults; `wrapperRunId`, `userRunId`,
 * `skipReason`, `error`, `tenantId`, `deliveredAt` are nullable per BRIDGE-1.
 */
export type BridgeDeliveryInsert = InferInsertModel<typeof bridgeDelivery>;

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
   * Lookup a delivery by its idempotency key. Returns `null` when no row
   * matches. Used by the framework handler (BRIDGE-5) to read the row that
   * the drain wrote, and by the facade in tests / dashboards.
   */
  findDelivery(
    eventId: string,
    triggerId: string,
  ): Promise<BridgeDeliveryRecord | null>;

  /**
   * Transition `pending` → `delivered`, populating `user_run_id` and
   * `delivered_at`. Called by `BridgeDeliveryHandler` after
   * `orchestrator.start(userJob)` returns.
   */
  markDelivered(
    id: string,
    userRunId: string,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * Transition `pending` → `skipped`, populating `skip_reason`. Called by
   * `BridgeDeliveryHandler` when the trigger's `when:` predicate returns
   * `false` or when the trigger no longer exists in the registry (rename
   * scenario from ADR-023 §Consequences).
   */
  markSkipped(
    id: string,
    reason: string,
    tx?: DrizzleTransaction,
  ): Promise<void>;

  /**
   * Transition `pending` → `failed`, populating `error`. Called by the
   * wrapper after its retry policy is exhausted; surfaces in ops
   * dashboards via the `idx_bridge_delivery_status` partial index.
   */
  markFailed(
    id: string,
    error: Record<string, unknown>,
    tx?: DrizzleTransaction,
  ): Promise<void>;
}

// ============================================================================
// IEventFlow — developer-facing facade (ADR-023 §Decision 7)
// ============================================================================

/**
 * Caller-supplied options for `IEventFlow.publishAndStart`.
 *
 * `tenantId` semantics match `IJobOrchestrator.StartOptions.tenantId`
 * (JOB-8): explicit `null` opts into cross-tenant work; `undefined` throws
 * `MissingTenantIdError` when `BridgeModule` is configured with
 * `multiTenant: true`.
 *
 * `parentRunId` lets request-path callers attach the eagerly-started run
 * to an existing run hierarchy (e.g. a higher-level orchestration that
 * publishes events as side effects of its own steps).
 */
export interface PublishAndStartOptions {
  parentRunId?: string;
  tenantId?: string | null;
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
   * `@JobHandler.triggers`); in-process `IEventBus.subscribe` handlers
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
   *   2. Synchronously calls `IJobOrchestrator.start(jobType, input,
   *      opts)` to enqueue the user job before returning to the caller.
   *   3. **Case B dedup** — if the (event, jobType) pair has a declared
   *      `@JobHandler.triggers` entry, the facade pre-writes a
   *      `bridge_delivery(status='delivered', user_run_id=<eagerRunId>)`
   *      row in the same transaction as `orchestrator.start(...)`. The
   *      drain's later `INSERT … ON CONFLICT (event_id, trigger_id) DO
   *      NOTHING` then sees the existing row and skips that trigger while
   *      still spawning any other triggers for the same event.
   *
   * Use when the caller needs the job enqueued before returning to the
   * user (request-path, within-transaction durability). For pure async
   * fanout where Tier 3 alone suffices, use `publish` instead.
   *
   * **Same-tx invariant** (BRIDGE-7): the outbox insert, the
   * `orchestrator.start` insert, and the Case B `bridge_delivery`
   * pre-write must all share a transaction. A crash between any two
   * leaves the system inconsistent (e.g. event published but no eager
   * run, or eager run with no Case B dedup row → drain double-spawns).
   *
   * **Note on signature:** ADR-023 §Decision 7 sketches `JobType` /
   * `JobInputOf<J>` parameters; the jobs subsystem currently models the
   * orchestrator's `start` as `start(type: string, input: unknown, …)`
   * with no generated `JobType` union analogous to events' `EventTypeName`.
   * The facade matches that shape today; tightening the surface is a
   * post-Phase-2 follow-up that requires generated job typing first.
   */
  publishAndStart<T extends EventTypeName>(
    event: EventOfType<T>,
    jobType: string,
    input: unknown,
    opts?: PublishAndStartOptions,
  ): Promise<PublishAndStartResult>;
}
