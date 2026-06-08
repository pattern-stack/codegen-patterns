/**
 * BridgeOutboxDrainHook — drains-time bridge fanout writer (BRIDGE-4,
 * ADR-023 Phase 2).
 *
 * Implements `IBridgeOutboxDrainHook`. Called by `DrizzleEventBus`'s
 * modified `processBatch` once per drained event, INSIDE the per-event
 * transaction. For every trigger registered against the event's type in
 * the codegen-emitted `bridgeRegistry`, writes:
 *
 *   1. `bridge_delivery` ledger row — `INSERT … ON CONFLICT (event_id,
 *      trigger_id) DO NOTHING RETURNING id`. Empty result ⇒ Case B
 *      facade-eager pre-write OR drain-replay collision; skip wrapper
 *      insert for that trigger; sibling triggers still fire.
 *   2. `job_run` wrapper row — `type='@framework/bridge_delivery'`,
 *      `pool='events_<direction>'`, `input={ deliveryId }`,
 *      `trigger_source='event'`, `trigger_ref=event.id`. The wrapper is
 *      what the framework `BridgeDeliveryHandler` (BRIDGE-5) eventually
 *      claims via the worker that polls the corresponding reserved pool.
 *
 * Null `event.metadata.direction` is tolerated: the hook logs a one-line
 * warning per event and returns zeros without writing rows. The drain's
 * `processed_at` stamp + subscriber dispatch still fire normally.
 * Direction is null only for events published via the legacy
 * `IEventBus.publish(...)` path (`TypedEventBus.publish` always sets it);
 * such events are out of scope for bridge fanout.
 *
 * The wrapper insert generates its own `id` via Drizzle's `defaultRandom`
 * — we don't `RETURNING id` because nobody needs it at drain time;
 * `BridgeDeliveryHandler` later looks up the wrapper via the
 * `bridge_delivery.wrapper_run_id` link if needed. This keeps the drain
 * one-round-trip-per-trigger.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { DomainEvent, DrizzleTransaction } from '../events/event-bus.protocol';
import { bridgeDelivery } from './bridge-delivery.schema';
import { jobRuns } from '../jobs/job-orchestration.schema';

import { BRIDGE_REGISTRY } from './bridge.tokens';
import type {
  BridgeOutboxDrainResult,
  BridgeRegistry,
  BridgeTriggerEntry,
  IBridgeOutboxDrainHook,
} from './bridge.protocol';
import { BRIDGE_DELIVERY_JOB_TYPE } from './bridge-delivery-handler';
import type { EventTypeName } from '../events/event-registry';
import { JOBS_LISTEN_NOTIFY } from '../jobs/jobs-domain.tokens';
import { JOBS_WAKE_CHANNEL, pgNotify } from '../jobs/pg-notify';

/** Reserved pools the wrapper rows route into; ADR-022 / ADR-024. */
const POOL_BY_DIRECTION: Record<string, string> = {
  inbound: 'events_inbound',
  change: 'events_change',
  outbound: 'events_outbound',
};

@Injectable()
export class BridgeOutboxDrainHook implements IBridgeOutboxDrainHook {
  private readonly logger = new Logger(BridgeOutboxDrainHook.name);
  private warnedNullDirection = false;
  private readonly warnedAuditTypes = new Set<string>();

  constructor(
    @Optional()
    @Inject(BRIDGE_REGISTRY)
    private readonly registry: BridgeRegistry = {},
    // LISTEN-NOTIFY-1 — when true, the wrapper `job_run` insert below emits an
    // in-tx `pg_notify(codegen_jobs_wake, <wrapperPool>)` so the reserved-pool
    // worker wakes the instant the per-event drain tx commits — otherwise the
    // bridge hop alone would still cost a full poll interval. `@Optional()`
    // defaulting false so the hook keeps working when jobs isn't installed
    // (bridge can drive non-jobs consumers) or in vendored/test wiring.
    @Optional()
    @Inject(JOBS_LISTEN_NOTIFY)
    private readonly listenNotify: boolean = false,
  ) {}

  async processEvent(
    event: DomainEvent,
    tx: DrizzleTransaction,
  ): Promise<BridgeOutboxDrainResult> {
    const triggers = this.lookupTriggers(event.type);

    // Audit-tier guard (defense-in-depth — AUDIT-4). Audit events are
    // bridge-inert by design: the codegen-side validator (AUDIT-2) blocks the
    // registry from listing them as triggers, so an audit event should never
    // have a matched trigger. The guard runs AFTER the lookup so it can tell
    // apart the two cases that share `tier === 'audit'`:
    //   - triggers present → genuine registry/runtime drift (an out-of-band
    //     `bridge_trigger` insert, or version skew during deploy). Refuse
    //     fanout and surface the drift via WARN — now a verified claim, not a
    //     guess. (Revises the original top-of-method guard, which warned for
    //     every audit event: audit-tier lifecycle events like
    //     `connection.created` routinely share the outbox with domain events,
    //     so the unconditional warning was a false positive. See
    //     ai-docs/specs/issue-242/plan.md §AUDIT-4 revision note.)
    //   - no triggers → the common, benign case. Stay silent; auditBlocked: 0.
    if (event.metadata?.['tier'] === 'audit') {
      if (triggers.length > 0) {
        this.warnAuditBlockedOnce(event, triggers);
        return {
          delivered: 0,
          dedupSkips: 0,
          triggerCount: 0,
          auditBlocked: 1,
        };
      }
      return {
        delivered: 0,
        dedupSkips: 0,
        triggerCount: 0,
        auditBlocked: 0,
      };
    }

    if (triggers.length === 0) {
      return {
        delivered: 0,
        dedupSkips: 0,
        triggerCount: 0,
        auditBlocked: 0,
      };
    }

    const direction =
      (event.metadata?.['direction'] as string | undefined) ?? null;
    const tenantId =
      (event.metadata?.['tenantId'] as string | null | undefined) ?? null;
    const wrapperPool = direction ? POOL_BY_DIRECTION[direction] : undefined;

    if (!wrapperPool) {
      // Null direction (or an unrecognised one — defensive). Bridge
      // fanout requires a routed wrapper pool; without one we can't
      // spawn. Log once per process so misconfiguration surfaces.
      if (!this.warnedNullDirection) {
        this.warnedNullDirection = true;
        this.logger.warn(
          `Skipping bridge fanout for events with null/unknown direction. ` +
            `event.id=${event.id} event.type=${event.type} ` +
            `direction=${String(direction)}. The wrapper pool is derived ` +
            `from direction (events_<direction>); publishers must use ` +
            `TypedEventBus.publish() so direction is stamped on the ` +
            `outbox row.`,
        );
      }
      return {
        delivered: 0,
        dedupSkips: 0,
        triggerCount: triggers.length,
        auditBlocked: 0,
      };
    }

    let delivered = 0;
    let dedupSkips = 0;
    const client = tx as unknown as {
      insert: (table: unknown) => {
        values: (v: unknown) => {
          onConflictDoNothing: (opts: unknown) => {
            returning: (cols: unknown) => Promise<{ id: string }[]>;
          };
        } & {
          // wrapper insert path — no ON CONFLICT
          // (typed loosely via the same helper return shape)
        };
      };
    };

    for (const trigger of triggers) {
      const deliveryId = randomUUID();
      const wrapperRunId = randomUUID();

      // FK ORDER (BRIDGE / 0.15.2): `bridge_delivery.wrapper_run_id` REFERENCES
      // `job_run(id)` is a plain (non-deferrable) FK, so the referenced
      // wrapper `job_run` MUST exist before the delivery row that points at it
      // is inserted — otherwise Postgres rejects the delivery insert
      // immediately. (The codegen unit tests mock `tx`, so they never
      // exercised this ordering against a real FK; package-mode bridge
      // deliveries are the first to do so.) We therefore insert the wrapper
      // run FIRST, then the delivery. Idempotency is unchanged: the delivery
      // keeps its `ON CONFLICT (event_id, trigger_id) DO NOTHING RETURNING`,
      // and when the delivery conflicts (outbox replay or facade-eager Case B)
      // we DELETE the just-inserted orphan wrapper run in the same tx, so a
      // skipped delivery leaves no stray `job_run` for a worker to claim.

      // 1. Wrapper job_run insert. We carry the deliveryId into the wrapper
      //    input so BridgeDeliveryHandler.run(ctx) can locate the row via
      //    repo.findDeliveryById(ctx.input.deliveryId).
      await (tx as unknown as { insert: typeof client.insert })
        .insert(jobRuns)
        .values({
          id: wrapperRunId,
          jobType: BRIDGE_DELIVERY_JOB_TYPE,
          jobVersion: 1,
          rootRunId: wrapperRunId,
          pool: wrapperPool,
          status: 'pending',
          input: { deliveryId },
          triggerSource: 'event',
          triggerRef: event.id,
          tenantId,
        });

      // 2. bridge_delivery insert with ON CONFLICT DO NOTHING + RETURNING.
      const inserted = await (tx as unknown as {
        insert: typeof client.insert;
      })
        .insert(bridgeDelivery)
        .values({
          id: deliveryId,
          eventId: event.id,
          triggerId: trigger.triggerId,
          wrapperRunId,
          status: 'pending',
          tenantId,
        })
        .onConflictDoNothing({
          target: [bridgeDelivery.eventId, bridgeDelivery.triggerId],
        })
        .returning({ id: bridgeDelivery.id });

      if (inserted.length === 0) {
        // Case B (facade pre-wrote `delivered`) or drain replay — the delivery
        // already exists, so this trigger is a no-op. Remove the orphan wrapper
        // run we speculatively inserted above so no worker claims it. Sibling
        // triggers still fire.
        await (tx as unknown as {
          delete: (table: unknown) => {
            where: (cond: unknown) => Promise<unknown>;
          };
        })
          .delete(jobRuns)
          .where(eq(jobRuns.id, wrapperRunId));
        dedupSkips++;
        continue;
      }

      // LISTEN-NOTIFY-1 — the wrapper run is real and claimable; wake its
      // reserved-pool worker on commit (D7). Same `tx` as the inserts above, so
      // delivery is gated on the per-event drain tx committing. Best-effort: a
      // notify failure is non-fatal (the reserved-pool worker still polls).
      if (this.listenNotify) {
        try {
          await pgNotify(tx, JOBS_WAKE_CHANNEL, wrapperPool);
        } catch (err) {
          this.logger.warn(
            `pg_notify(${JOBS_WAKE_CHANNEL}, ${wrapperPool}) failed for ` +
              `wrapper run ${wrapperRunId}: ${(err as Error).message} ` +
              `(non-fatal — the reserved-pool worker still polls).`,
          );
        }
      }

      delivered++;
    }

    return {
      delivered,
      dedupSkips,
      triggerCount: triggers.length,
      auditBlocked: 0,
    };
  }

  private warnAuditBlockedOnce(
    event: DomainEvent,
    triggers: BridgeTriggerEntry[],
  ): void {
    if (this.warnedAuditTypes.has(event.type)) return;
    this.warnedAuditTypes.add(event.type);
    const triggerIds = triggers.map((t) => t.triggerId).join(', ');
    this.logger.warn(
      `Bridge guard blocked audit-tier event '${event.type}' (event.id=${event.id}). ` +
        `Audit events are not bridge-eligible, yet the registry has trigger(s) ` +
        `registered against this type [${triggerIds}] — an out-of-band bridge_trigger ` +
        `row or version skew. Investigate registry/runtime drift.`,
    );
  }

  private lookupTriggers(
    eventType: string,
  ): BridgeTriggerEntry[] {
    const candidates = this.registry[eventType as EventTypeName];
    return (candidates ?? []) as BridgeTriggerEntry[];
  }
}
