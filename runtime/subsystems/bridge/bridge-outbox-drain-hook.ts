/**
 * BridgeOutboxDrainHook — the event → job bridge, inside the outbox drain's per-event transaction (ADR-023, JOBS-3).
 *
 * For each trigger the generated `bridgeRegistry` declares for the event's type, in the event's own transaction:
 *
 *   1. writes the `bridge_delivery (event_id, trigger_id)` row; the UNIQUE key makes an outbox replay, or a
 *      `publishAndStart` that already delivered the pair, a skip (`dedupSkips`);
 *   2. reads the trigger's `when` (false: `skipped`, `predicate_false`) and a job this process doesn't register
 *      (`skipped`, `trigger_unregistered`);
 *   3. starts the user's run with `JobStarter.start(..., tx)`: `startRun` over a store built on the same transaction,
 *      trigger `event`, the event's tenant (`SYSTEM_TENANT` for none);
 *   4. marks the delivery `delivered` with the run's id.
 *
 * Exactly once comes from that transaction: the delivery row and the run commit together or not at all, and the
 * delivery's UNIQUE key refuses a second one. It never leans on a dedupe key or window. There is no wrapper job, no
 * reserved `events_*` pool and no runtime-typed child run (ADR-022's `BridgeDeliveryHandler` is gone). The run is found
 * by the jobs executor's open-run sweep once the drain commits.
 *
 * A trigger that cannot start (its `map` throws, the job refuses the input, a missing budget) fails ALONE: its start
 * runs in a savepoint, so its run rolls back, its delivery is marked `failed` with the error, and the event's other
 * triggers, its subscribers and its `processed_at` go ahead. Rolling the whole event back instead would retry it on
 * every drain, for good, behind one bad trigger. A failed delivery is not retried (the UNIQUE row stands); it is the
 * ledger's record for an operator. Infrastructure errors on the event's own transaction still propagate.
 */
import { Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { DomainEvent, DrizzleTransaction } from '../events/event-bus.protocol';
import type { EventTypeName } from '../events/event-registry';
import { JobStarter } from '../jobs/job-starter';
import { bridgeDelivery } from './bridge-delivery.schema';
import { BRIDGE_REGISTRY } from './bridge.tokens';
import type {
  BridgeOutboxDrainResult,
  BridgeRegistry,
  BridgeTriggerEntry,
  IBridgeOutboxDrainHook,
} from './bridge.protocol';

/** The slice of Drizzle's transaction the hook writes the ledger through, and opens a trigger's savepoint on. */
interface LedgerClient {
  transaction<T>(fn: (savepoint: DrizzleTransaction) => Promise<T>): Promise<T>;
  insert(table: typeof bridgeDelivery): {
    values(v: typeof bridgeDelivery.$inferInsert): {
      onConflictDoNothing(opts: { target: unknown[] }): {
        returning(cols: { id: typeof bridgeDelivery.id }): Promise<{ id: string }[]>;
      };
    };
  };
  update(table: typeof bridgeDelivery): {
    set(v: Partial<typeof bridgeDelivery.$inferInsert>): { where(cond: unknown): Promise<unknown> };
  };
}

@Injectable()
export class BridgeOutboxDrainHook implements IBridgeOutboxDrainHook, OnApplicationBootstrap {
  private readonly logger = new Logger(BridgeOutboxDrainHook.name);
  private readonly warnedAuditTypes = new Set<string>();

  constructor(
    private readonly jobs: JobStarter,
    @Optional()
    @Inject(BRIDGE_REGISTRY)
    private readonly registry: BridgeRegistry = {},
  ) {}

  /**
   * Every trigger names a job this app registers, or the boot stops: `jobTriggers('<key>', …)` is a string, and a key
   * no `defineJob` carries (a typo, a renamed job) would otherwise be skipped as `trigger_unregistered` for good.
   * Every process runs the same generated registry, so a mismatch is never a deliberate split.
   */
  onApplicationBootstrap(): void {
    const unknown = Object.values(this.registry)
      .flat()
      .filter((t) => t && !this.jobs.has((t as BridgeTriggerEntry).jobKey)) as BridgeTriggerEntry[];
    if (unknown.length > 0) {
      throw new Error(
        `bridge triggers name jobs this app does not register: ${unknown.map((t) => `'${t.triggerId}' → '${t.jobKey}'`).join(', ')}. ` +
          `Check each jobTriggers('<key>', …) against its defineJob({ key }), then re-run codegen entity new.`,
      );
    }
  }

  async processEvent(event: DomainEvent, tx: DrizzleTransaction): Promise<BridgeOutboxDrainResult> {
    const triggers = this.lookupTriggers(event.type);
    // Audit-tier events are never bridge-eligible (EVT-6): a trigger on one is registry drift, said once.
    if (event.metadata?.['tier'] === 'audit') {
      if (triggers.length > 0) this.warnAuditBlockedOnce(event, triggers);
      return { delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: triggers.length > 0 ? 1 : 0 };
    }
    if (triggers.length === 0) return { delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 0 };

    const tenantId = (event.metadata?.['tenantId'] as string | null | undefined) ?? null;
    const ledger = tx as unknown as LedgerClient;
    let delivered = 0;
    let dedupSkips = 0;
    for (const trigger of triggers) {
      const [row] = await ledger
        .insert(bridgeDelivery)
        .values({ eventId: event.id, triggerId: trigger.triggerId, status: 'pending', tenantId })
        .onConflictDoNothing({ target: [bridgeDelivery.eventId, bridgeDelivery.triggerId] })
        .returning({ id: bridgeDelivery.id });
      if (!row) {
        dedupSkips++;
        continue;
      }
      const mark = (set: Partial<typeof bridgeDelivery.$inferInsert>) =>
        ledger.update(bridgeDelivery).set(set).where(and(eq(bridgeDelivery.id, row.id)));
      if (!this.jobs.has(trigger.jobKey)) {
        await mark({ status: 'skipped', skipReason: 'trigger_unregistered' });
        continue;
      }
      if (trigger.when && !trigger.when(event as never)) {
        await mark({ status: 'skipped', skipReason: 'predicate_false' });
        continue;
      }
      let runId: string;
      try {
        runId = await ledger.transaction(async (savepoint) => {
          const { run } = await this.jobs.start(
            trigger.jobKey,
            trigger.map(event as never),
            { tenantId, trigger: 'event', ...(trigger.dedupeKey ? { dedupeKey: trigger.dedupeKey(event as never) } : {}) },
            savepoint,
          );
          return run.id;
        });
      } catch (err) {
        const error = { type: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : String(err) };
        await mark({ status: 'failed', error });
        this.logger.warn(
          `bridge trigger '${trigger.triggerId}' on event ${event.id} (${event.type}) did not start: ${error.type}: ${error.message}`,
        );
        continue;
      }
      await mark({ status: 'delivered', userRunId: runId, deliveredAt: new Date() });
      delivered++;
    }
    return { delivered, dedupSkips, triggerCount: triggers.length, auditBlocked: 0 };
  }

  private warnAuditBlockedOnce(event: DomainEvent, triggers: BridgeTriggerEntry[]): void {
    if (this.warnedAuditTypes.has(event.type)) return;
    this.warnedAuditTypes.add(event.type);
    this.logger.warn(
      `Bridge guard blocked audit-tier event '${event.type}' (event.id=${event.id}). ` +
        `Audit events are not bridge-eligible, yet the registry has trigger(s) ` +
        `registered against this type [${triggers.map((t) => t.triggerId).join(', ')}]. ` +
        `Investigate registry/runtime drift.`,
    );
  }

  private lookupTriggers(eventType: string): BridgeTriggerEntry[] {
    return (this.registry[eventType as EventTypeName] ?? []) as BridgeTriggerEntry[];
  }
}
