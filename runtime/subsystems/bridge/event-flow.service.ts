/**
 * EventFlowService — `IEventFlow` facade implementation (BRIDGE-7,
 * ADR-023 §Decision 7 + §`publishAndStart` + existing `triggers:` collision).
 *
 * Two verbs:
 *
 *   - `publish(event, tx?)` — thin delegate to `IEventBus.publish(event, tx)`.
 *     Subscribers + bridge triggers fire as normal. Caller owns transaction.
 *
 *   - `publishAndStart(event, jobType, input, opts?)` — the load-bearing
 *     verb. Opens a transaction and performs THREE writes inside it:
 *       1. Outbox insert via `eventBus.publish(event, tx)`.
 *       2. Eager `orchestrator.start(jobType, input, opts, tx)`.
 *       3. **Case B only** — for every `bridgeRegistry[event.type]` entry
 *          whose `jobType` matches the argument, pre-write a
 *          `bridge_delivery(status='delivered', wrapper_run_id=null,
 *          user_run_id=<eagerRunId>)` row via `bridgeRepo.insertDelivery(
 *          row, tx)`. The `UNIQUE (event_id, trigger_id)` constraint then
 *          dedups the drain's later attempt for that trigger; sibling
 *          triggers (different trigger_id) still spawn normally.
 *
 *     Returns `{ runId }` from the eager start. All three writes share
 *     one tx — a crash anywhere rolls back all of them; the drain
 *     re-claims the event on the next cycle and the bridge UNIQUE makes
 *     the retry idempotent.
 *
 * **Pre-write ALL matching triggerIds** (lead decision 2026-04-22): the
 * facade uses `filter()` not `find()`. If a project has two triggers in
 * the registry for the same `(event, jobType)` pair (rare; codegen-time
 * `DuplicateTriggerError` from BRIDGE-7's BRIDGE-6 follow-up patch
 * prevents new occurrences), each gets its own pre-write — otherwise
 * the un-pre-written sibling would spawn a wrapper that re-runs the user
 * job, producing a double-spawn.
 *
 * **Multi-tenancy gate** at `publishAndStart` entry: when
 * `BRIDGE_MULTI_TENANT=true` and `opts?.tenantId === undefined`, throw
 * `MissingTenantIdError('EventFlowService.publishAndStart')`. Site (a)
 * of the three ADR-023 §Multi-tenancy enforcement sites (BRIDGE-5
 * handler is (b); BRIDGE-4 drizzle repo is (c)).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';

import { EVENT_BUS } from '../events/events.tokens';
import type {
  DomainEvent,
  DrizzleTransaction,
  IEventBus,
} from '../events/event-bus.protocol';
import type {
  EventOfType,
  EventTypeName,
} from '../events/event-registry';

import { JOB_ORCHESTRATOR } from '../jobs/jobs-domain.tokens';
import type { IJobOrchestrator } from '../jobs/job-orchestrator.protocol';

import {
  BRIDGE_DELIVERY_REPO,
  BRIDGE_MULTI_TENANT,
  BRIDGE_REGISTRY,
} from './bridge.tokens';
import type {
  BridgeRegistry,
  BridgeTriggerEntry,
  IEventFlow,
  IJobBridge,
  PublishAndStartOptions,
  PublishAndStartResult,
} from './bridge.protocol';
import { assertTenantId } from './assert-tenant-id';

@Injectable()
export class EventFlowService implements IEventFlow {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Inject(EVENT_BUS) private readonly eventBus: IEventBus,
    @Inject(JOB_ORCHESTRATOR) private readonly orchestrator: IJobOrchestrator,
    @Inject(BRIDGE_DELIVERY_REPO) private readonly bridgeRepo: IJobBridge,
    @Optional()
    @Inject(BRIDGE_REGISTRY)
    private readonly registry: BridgeRegistry = {},
    @Optional()
    @Inject(BRIDGE_MULTI_TENANT)
    private readonly multiTenant: boolean = false,
  ) {}

  async publish<T extends EventTypeName>(
    event: EventOfType<T>,
    tx?: DrizzleTransaction,
  ): Promise<void> {
    // Thin delegate. Subscribers + bridge triggers fire as normal via the
    // outbox drain (BRIDGE-4) and `IEventBus.subscribe` (Tier 1).
    await this.eventBus.publish(event as DomainEvent, tx);
  }

  async publishAndStart<T extends EventTypeName>(
    event: EventOfType<T>,
    jobType: string,
    input: unknown,
    opts: PublishAndStartOptions = {},
  ): Promise<PublishAndStartResult> {
    // Multi-tenancy gate — throw before any DB write so failures surface
    // at the call site, not from inside an aborted tx. Site (a) of the
    // three ADR-023 §Multi-tenancy enforcement sites; shared helper from
    // BRIDGE-8 keeps all three sites in lock-step.
    assertTenantId(
      'EventFlowService.publishAndStart',
      this.multiTenant,
      opts.tenantId,
    );
    // Resolve null → null (cross-tenant work) once, so the same value
    // flows to both the eager start AND the bridge_delivery row.
    const tenantId: string | null = opts.tenantId ?? null;

    // Identify Case B — every registry entry whose jobType matches.
    // Lead decision 2026-04-22: pre-write ALL matches (filter, not find)
    // so duplicate triggers in the registry don't double-spawn.
    const matchingTriggers = this.matchingTriggers(event.type as EventTypeName, jobType);

    return this.db.transaction(async (tx) => {
      // 1. Outbox insert.
      await this.eventBus.publish(event as DomainEvent, tx);

      // 2. Eager start. Threads tx through (BRIDGE-7 protocol extension
      //    on IJobOrchestrator.start, JOB-3 backend uses `tx ?? this.db`).
      const run = await this.orchestrator.start(
        jobType,
        input,
        {
          parentRunId: opts.parentRunId,
          tenantId,
          triggerSource: 'event',
          triggerRef: event.id,
        },
        tx,
      );

      // 3. Case B pre-writes — one per matching trigger.
      const now = new Date();
      for (const trigger of matchingTriggers) {
        await this.bridgeRepo.insertDelivery(
          {
            eventId: event.id,
            triggerId: trigger.triggerId,
            wrapperRunId: null, // facade never writes a wrapper
            userRunId: run.id,
            status: 'delivered',
            tenantId,
            attemptedAt: now,
            deliveredAt: now,
          },
          tx,
        );
      }

      return { runId: run.id };
    });
  }

  /**
   * Linear scan of the per-event-type trigger list for entries whose
   * `jobType` matches. Typical N is 1–5; the table is not big enough to
   * warrant a secondary index. Returns an empty array for Case A.
   */
  private matchingTriggers(
    eventType: EventTypeName,
    jobType: string,
  ): BridgeTriggerEntry[] {
    const triggers = this.registry[eventType] ?? [];
    return triggers.filter((t) => t.jobType === jobType) as BridgeTriggerEntry[];
  }
}
