/**
 * BridgeOutboxDrainer — the event → job bridge, framework-free (J-1), inside the outbox drain's per-event transaction
 * (ADR-023, JOBS-3).
 *
 * For each trigger the generated `bridgeRegistry` declares for the event's type, in the event's own transaction:
 *
 *   1. claims the `bridge_delivery (event_id, trigger_id)` row through the delivery ledger (`claimDelivery`, its one
 *      writer, which asserts the tenant: a multi-tenant bridge refuses an event with no tenant); the UNIQUE key makes
 *      an outbox replay, or a `publishAndStart` that already delivered the pair, a skip (`dedupSkips`);
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
 * A trigger that cannot start through its OWN fault fails ALONE: its `when`, `map` or `dedupeKey` throws, or the
 * engine refuses the start (a refused input, a definition error, a missing budget: `isTriggerFault`). Its start runs
 * in a savepoint, so its run rolls back, its delivery is marked `failed` with the error, and the event's other
 * triggers, its subscribers and its `processed_at` go ahead. Rolling the whole event back instead would retry it on
 * every drain, for good, behind one bad trigger. A failed delivery is not retried (the UNIQUE row stands); it is the
 * ledger's record for an operator. Any other error (a deadlock, a lock or statement timeout, a dropped connection)
 * is no fault of the trigger: it propagates, the event rolls back, and the next drain retries it.
 *
 * The Nest host is `BridgeOutboxDrainHook` (the trigger check at bootstrap; a Nest 4xx is a trigger fault too). A
 * pattern-stack app's `events` system builds this class over the `jobs` system's starter and the Drizzle ledger,
 * checks it, and passes it to the bus.
 */
import { NonRetryableError } from '@pattern-stack/jobs';
import { JobBudgetError } from '@pattern-stack/jobs/host';

import type { DomainEvent, DrizzleTransaction } from '../events/event-bus.protocol';
import type { EventTypeName } from '../events/event-registry';
import { createLogger } from '../../logger';
import type { JobStartOptions } from '../jobs/job-run-starter';
import type {
  BridgeOutboxDrainResult,
  BridgeRegistry,
  BridgeTriggerEntry,
  IBridgeOutboxDrainHook,
  IJobBridge,
} from './bridge.protocol';

/** The slice of Drizzle's transaction the drainer opens a trigger's savepoint on. */
interface SavepointClient {
  transaction<T>(fn: (savepoint: DrizzleTransaction) => Promise<T>): Promise<T>;
}

/** What the drainer starts runs through: the jobs subsystem's starter (`JobRunStarter`, or Nest's `JobStarter`). */
export interface BridgeJobStarter {
  has(jobKey: string): boolean;
  start(jobKey: string, input: unknown, options: JobStartOptions, tx?: unknown): Promise<{ run: { id: string } }>;
}

/** What the drainer writes the ledger through, on the event's transaction: the delivery repo, its one writer. */
export type BridgeDeliveryLedger = Pick<IJobBridge, 'claimDelivery' | 'markSkipped' | 'markFailed' | 'markDelivered'>;

/** A trigger's own code threw (`when`, `map`, `dedupeKey`): its fault, whatever it threw. */
class TriggerCodeError extends Error {
  constructor(readonly thrown: unknown) {
    super(thrown instanceof Error ? thrown.message : String(thrown));
    this.name = thrown instanceof Error ? thrown.name : typeof thrown;
  }
}

/** Runs a trigger's own code, marking what it throws as the trigger's fault. */
function own<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new TriggerCodeError(err);
  }
}

export class BridgeOutboxDrainer implements IBridgeOutboxDrainHook {
  private readonly logger = createLogger('BridgeOutboxDrainHook');
  private readonly warnedAuditTypes = new Set<string>();

  constructor(
    private readonly jobs: BridgeJobStarter,
    private readonly deliveries: BridgeDeliveryLedger,
    private readonly registry: BridgeRegistry = {},
  ) {}

  /**
   * Every trigger names a job this app registers, or the boot stops: `jobTriggers('<key>', …)` is a string, and a key
   * no `defineJob` carries (a typo, a renamed job) would otherwise be skipped as `trigger_unregistered` for good.
   * Every process runs the same generated registry, so a mismatch is never a deliberate split.
   */
  assertTriggersRegistered(): void {
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

  /**
   * Whether a start failed through the trigger's own fault, so its delivery is `failed` and the event goes on: its own
   * code threw, the engine refused it (`NonRetryableError`: a refused input, a definition error), or the budget rule
   * did (`JobBudgetError`: a job with no limits and no `budget.maxItems`). Anything else is retried with the event. A
   * host widens it with its own refusals (Nest: a 4xx).
   */
  protected isTriggerFault(err: unknown): boolean {
    return err instanceof TriggerCodeError || err instanceof NonRetryableError || err instanceof JobBudgetError;
  }

  async processEvent(event: DomainEvent, tx: DrizzleTransaction): Promise<BridgeOutboxDrainResult> {
    const triggers = this.lookupTriggers(event.type);
    // Audit-tier events are never bridge-eligible (EVT-6): a trigger on one is registry drift, said once.
    if (event.metadata?.['tier'] === 'audit') {
      if (triggers.length > 0) this.warnAuditBlockedOnce(event, triggers);
      return { delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: triggers.length > 0 ? 1 : 0 };
    }
    if (triggers.length === 0) return { delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 0 };

    // As the event carries it: `undefined` (no tenant metadata) is the ledger's to refuse under a multi-tenant bridge.
    const tenantId = event.metadata?.['tenantId'] as string | null | undefined;
    let delivered = 0;
    let dedupSkips = 0;
    for (const trigger of triggers) {
      const id = await this.deliveries.claimDelivery({ eventId: event.id, triggerId: trigger.triggerId, tenantId }, tx);
      if (id === null) {
        dedupSkips++;
        continue;
      }
      if (!this.jobs.has(trigger.jobKey)) {
        await this.deliveries.markSkipped(id, 'trigger_unregistered', tx);
        continue;
      }
      let runId: string | null;
      try {
        runId = await (tx as unknown as SavepointClient).transaction(async (savepoint) => {
          if (trigger.when && !own(() => trigger.when?.(event as never))) return null;
          const input = own(() => trigger.map(event as never));
          const dedupeKey = trigger.dedupeKey ? own(() => trigger.dedupeKey?.(event as never)) : undefined;
          const { run } = await this.jobs.start(
            trigger.jobKey,
            input,
            { tenantId: tenantId ?? null, trigger: 'event', ...(dedupeKey !== undefined ? { dedupeKey } : {}) },
            savepoint,
          );
          return run.id;
        });
      } catch (err) {
        if (!this.isTriggerFault(err)) throw err;
        const error = { type: (err as Error).name, message: (err as Error).message };
        await this.deliveries.markFailed(id, error, tx);
        this.logger.warn(
          `bridge trigger '${trigger.triggerId}' on event ${event.id} (${event.type}) did not start: ${error.type}: ${error.message}`,
        );
        continue;
      }
      if (runId === null) {
        await this.deliveries.markSkipped(id, 'predicate_false', tx);
        continue;
      }
      await this.deliveries.markDelivered(id, runId, tx);
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
