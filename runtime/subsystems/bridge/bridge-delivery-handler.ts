/**
 * BridgeDeliveryHandler — the framework `@JobHandler` that runs every
 * bridge-fanout wrapper on the reserved `events_*` pools (BRIDGE-5,
 * ADR-023 §Decision 2 flow diagram).
 *
 * Role: when the outbox drain (BRIDGE-4) inserts a `bridge_delivery + wrapper
 * job_run` pair, the worker that polls the wrapper's pool claims that
 * wrapper and dispatches it to this handler. The handler:
 *
 *   1. Loads the `bridge_delivery` row by `ctx.input.deliveryId`.
 *   2. Looks up the trigger entry in the codegen-emitted `bridgeRegistry`
 *      (`runtime/subsystems/bridge/generated/registry.ts`, BRIDGE-6).
 *      A missing entry means the trigger was renamed or removed since the
 *      delivery row was written; mark `skipped` with
 *      `skip_reason='trigger_unregistered'` per ADR-023 §Trigger rename
 *      or removal.
 *   3. Re-fetches the authoritative `domain_events` row (`IEventBus.findById`)
 *      so `when:` / `map:` callbacks see the committed payload — never a
 *      copy that drifted between drain and claim time.
 *   4. Evaluates `entry.when?.(event)`. False ⇒ mark `skipped` with
 *      `skip_reason='predicate_false'`.
 *   5. Calls `IJobOrchestrator.start(entry.jobType, entry.map(event), …)`
 *      INSIDE `ctx.step('spawn_user_run', …)`. The step memoization is
 *      what makes wrapper retries (BRIDGE-1 ledger says no auto-retry past
 *      the wrapper's own retry policy, but Phase 1 wrappers DO retry per
 *      JOB-3) idempotent — a successful spawn followed by a transient
 *      ledger-update failure would otherwise re-spawn on the next attempt.
 *   6. Marks `delivered` with the spawned `runId`.
 *
 * Pool registration: BRIDGE-5 ships ONE `@JobHandler` registration with
 * `pool: 'events_change'` (the default). The wrapper rows the drain
 * inserts carry `pool: events_<direction>` per row, so workers polling
 * `events_inbound` / `events_outbound` claim and dispatch to this same
 * handler class regardless of the metadata pool — the worker filter is on
 * `job_run.pool`, not on `@JobHandler.meta.pool`. BRIDGE-8 confirms the
 * three pools are active and registered at module init. The
 * `@framework/*` job-type prefix exempts this registration from the
 * reserved-pool validator (BRIDGE-5 added that exemption to
 * `job-worker.module.ts`).
 *
 * Tenant threading: when `BRIDGE_MULTI_TENANT=true`, the handler asserts
 * `delivery.tenantId !== undefined` before the spawn (the column is
 * nullable, so explicit `null` is allowed for cross-tenant work — same
 * contract as JOB-8). BRIDGE-8 wires the assertion via the
 * `BRIDGE_MULTI_TENANT` token.
 *
 * Failure path: any throw inside the handler propagates up; the worker's
 * normal retry policy (declared on the `@JobHandler` here as `attempts:
 * 3, backoff: exponential, baseMs: 250`) absorbs transient infra blips.
 * After exhaustion, the wrapper transitions to `failed`; the outer error
 * handler catches and calls `repo.markFailed(...)` so the delivery row
 * reflects the final state. Operators see `bridge_delivery.status='failed'`
 * surface via the `idx_bridge_delivery_status` partial index (BRIDGE-1).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { JOB_ORCHESTRATOR } from '../jobs/jobs-domain.tokens';
import type { IJobOrchestrator } from '../jobs/job-orchestrator.protocol';
import {
  JobHandler,
  JobHandlerBase,
  type JobContext,
} from '../jobs/job-handler.base';

import { EVENT_BUS } from '../events/events.tokens';
import type { IEventBus, DomainEvent } from '../events/event-bus.protocol';
import type { EventTypeName } from '../events/generated/types';

import {
  BRIDGE_DELIVERY_REPO,
  BRIDGE_MULTI_TENANT,
  BRIDGE_REGISTRY,
} from './bridge.tokens';
import type {
  BridgeRegistry,
  BridgeTriggerEntry,
  IJobBridge,
} from './bridge.protocol';
import { assertTenantId } from './assert-tenant-id';

/** Stable canonical job type — referenced by BRIDGE-4 wrapper inserts. */
export const BRIDGE_DELIVERY_JOB_TYPE = '@framework/bridge_delivery' as const;

/** Stable canonical step id — referenced for memoization across attempts. */
const SPAWN_USER_RUN_STEP = 'spawn_user_run' as const;

export interface BridgeDeliveryInput {
  /** PK of the `bridge_delivery` row this wrapper services. */
  deliveryId: string;
}

@Injectable()
@JobHandler<BridgeDeliveryInput>(BRIDGE_DELIVERY_JOB_TYPE, {
  pool: 'events_change',
  retry: { attempts: 3, backoff: 'exponential', baseMs: 250 },
  replayFrom: 'last_step',
})
export class BridgeDeliveryHandler extends JobHandlerBase<
  BridgeDeliveryInput,
  { runId: string } | { skipped: true; reason: string }
> {
  private readonly classLogger = new Logger(BridgeDeliveryHandler.name);

  constructor(
    @Inject(BRIDGE_DELIVERY_REPO) private readonly repo: IJobBridge,
    @Inject(JOB_ORCHESTRATOR) private readonly orchestrator: IJobOrchestrator,
    @Inject(EVENT_BUS) private readonly events: IEventBus,
    @Inject(BRIDGE_REGISTRY) private readonly registry: BridgeRegistry,
    @Optional()
    @Inject(BRIDGE_MULTI_TENANT)
    private readonly multiTenant: boolean = false,
  ) {
    super();
  }

  async run(
    ctx: JobContext<BridgeDeliveryInput>,
  ): Promise<{ runId: string } | { skipped: true; reason: string }> {
    const { deliveryId } = ctx.input;

    // Step 1 — locate the delivery row by primary key.
    const delivery = await this.repo.findDeliveryById(deliveryId);
    if (!delivery) {
      // The drain wrote a wrapper job_run but the delivery row is gone
      // (manual ops cleanup, or delete-cascade from the parent event).
      // No row → no work; return without throwing so the wrapper marks
      // completed cleanly.
      this.classLogger.warn(
        `bridge_delivery row '${deliveryId}' not found; wrapper completes ` +
          `without spawning a user job.`,
      );
      return { skipped: true, reason: 'delivery_row_missing' };
    }

    // Step 2 — multi-tenancy gate. Site (b) of the three ADR-023
    // §Multi-tenancy enforcement sites; shared helper from BRIDGE-8.
    // The DB always returns string|null, never undefined; this branch
    // exists for the in-memory backend's older test fixtures and to
    // pin the contract in shape-typed tests.
    assertTenantId(
      'BridgeDeliveryHandler.run',
      this.multiTenant,
      delivery.tenantId,
    );

    // Step 3 — load the typed event row.
    const event = await this.events.findById(delivery.eventId);
    if (!event) {
      // FK from bridge_delivery.event_id → domain_events.id should make
      // this impossible at the DB layer, but defensive: if the row is
      // missing we mark skipped, not failed (no work the bridge can do).
      this.classLogger.warn(
        `domain_events row '${delivery.eventId}' missing for delivery ` +
          `'${deliveryId}'; marking skipped.`,
      );
      await this.repo.markSkipped(delivery.id, 'event_row_missing');
      return { skipped: true, reason: 'event_row_missing' };
    }

    // Step 4 — registry lookup. Handles trigger rename/removal cleanly.
    const entry = this.findRegistryEntry(event.type, delivery.triggerId);
    if (!entry) {
      await this.repo.markSkipped(delivery.id, 'trigger_unregistered');
      return { skipped: true, reason: 'trigger_unregistered' };
    }

    // Step 5 — `when:` predicate.
    if (entry.when && !entry.when(event as never)) {
      await this.repo.markSkipped(delivery.id, 'predicate_false');
      return { skipped: true, reason: 'predicate_false' };
    }

    // Step 6 — memoized spawn. `ctx.step` records the result in
    // `job_step` and on retry returns the cached `{ runId }` so a
    // transient failure between `orchestrator.start` and `markDelivered`
    // doesn't double-spawn the user job.
    const input = entry.map(event as never);
    const { runId } = await ctx.step<{ runId: string }>(
      SPAWN_USER_RUN_STEP,
      async () => {
        const run = await this.orchestrator.start(entry.jobType, input, {
          parentRunId: ctx.run.id,
          triggerSource: 'event',
          triggerRef: delivery.eventId,
          tenantId: delivery.tenantId,
        });
        return { runId: run.id };
      },
    );

    // Step 7 — ledger transition.
    await this.repo.markDelivered(delivery.id, runId);
    return { runId };
  }

  /**
   * Locate the registry entry for `(eventType, triggerId)`. Linear scan
   * over the per-event-type array — N is the number of triggers declared
   * for one event, typically 1–5; the table is not big enough to warrant
   * a secondary index.
   */
  private findRegistryEntry(
    eventType: string,
    triggerId: string,
  ): BridgeTriggerEntry | undefined {
    const candidates =
      this.registry[eventType as EventTypeName] ?? undefined;
    if (!candidates) return undefined;
    return candidates.find((c) => c.triggerId === triggerId) as
      | BridgeTriggerEntry
      | undefined;
  }
}

/**
 * Re-export for BRIDGE-7 facade Case B and BRIDGE-4 wrapper insert.
 * Single source of truth for the canonical type string keeps refactors
 * in one place.
 */
export { BRIDGE_DELIVERY_JOB_TYPE as BridgeDeliveryJobType };
