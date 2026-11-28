/**
 * Unit tests for `EventFlowService` (BRIDGE-7, ADR-023 §Decision 7).
 *
 * Wires the facade against a stub `IEventBus`, a fake `JobStarter` (JOBS-3),
 * and `MemoryBridgeDeliveryRepo` for the bridge ledger. The "transaction"
 * is faked via a stub `db.transaction(cb)` that simply runs `cb(tx)` —
 * tests assert call-shape, ordering, rollback semantics, and the
 * Case-A/B branching exactly per the spec.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  EventFlowService,
  MemoryBridgeDeliveryRepo,
  MissingTenantIdError,
  type BridgeRegistry,
  type IJobBridge,
} from '../../../../runtime/subsystems/bridge';
import type { DomainEvent, IEventBus } from '../../../../runtime/subsystems/events/event-bus.protocol';
import type { JobStarter } from '../../../../runtime/subsystems/jobs/job-starter';

/** What the fake `JobStarter.start` resolves to: the run (only its id is read) and whether it was created. */
const started = (id: string) => ({ run: { id }, created: true });

// ─── Test infrastructure ────────────────────────────────────────────────────

const EVENT_ID = '00000000-0000-0000-0000-000000000aaa';
const EVENT_TYPE = 'contact_created';
const JOB_KEY = 'send_welcome_email';

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: EVENT_ID,
    type: EVENT_TYPE,
    aggregateId: 'agg-1',
    aggregateType: 'contact',
    payload: { contactId: 'agg-1' },
    occurredAt: new Date('2026-04-22T00:00:00Z'),
    metadata: { direction: 'change' },
    ...overrides,
  };
}

interface Harness {
  /** Fake db with a `transaction(cb)` that simply runs cb(opaqueTx). */
  db: { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  bus: { publish: ReturnType<typeof mock>; calls: Array<[DomainEvent, unknown]> };
  repo: MemoryBridgeDeliveryRepo;
  jobs: JobStarter;
  startSpy: ReturnType<typeof mock>;
  /** Each tx body invocation increments this. */
  txInvocations: number;
  /** Tx commits + rollbacks counted via mock harness. */
  rolledBack: boolean;
}

function makeHarness(opts: {
  spawnedRunId?: string;
  insertDeliveryFails?: boolean;
} = {}): Harness {
  let txInvocations = 0;
  let rolledBack = false;

  const busCalls: Array<[DomainEvent, unknown]> = [];
  const bus: Harness['bus'] = {
    publish: mock(async (event: DomainEvent, tx: unknown) => {
      busCalls.push([event, tx]);
    }),
    calls: busCalls,
  };

  const repo = new MemoryBridgeDeliveryRepo();
  if (opts.insertDeliveryFails) {
    // Wrap insertDelivery to throw — tests rollback semantics.
    const orig = repo.insertDelivery.bind(repo);
    repo.insertDelivery = mock(async () => {
      throw new Error('simulated insertDelivery failure');
    }) as never;
    void orig;
  }

  const startSpy = mock(
    async (_key: string, _input: unknown, _opts?: unknown, _tx?: unknown) =>
      started(opts.spawnedRunId ?? 'eager-run-id'),
  );

  const jobs = { has: () => true, start: startSpy } as unknown as JobStarter;

  const db: Harness['db'] = {
    transaction: async (cb) => {
      txInvocations++;
      const opaqueTx = { __tx: txInvocations };
      try {
        const out = await cb(opaqueTx);
        return out;
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    },
  };

  return {
    db,
    bus,
    repo,
    jobs,
    startSpy,
    get txInvocations() {
      return txInvocations;
    },
    get rolledBack() {
      return rolledBack;
    },
  };
}

function registryWith(
  ...triggers: Array<{ event?: string; triggerId: string; jobKey: string }>
): BridgeRegistry {
  const map: Record<string, unknown[]> = {};
  for (const t of triggers) {
    const evt = t.event ?? EVENT_TYPE;
    map[evt] = map[evt] ?? [];
    (map[evt] as unknown[]).push({
      triggerId: t.triggerId,
      jobKey: t.jobKey,
      map: () => ({}),
    });
  }
  return map as unknown as BridgeRegistry;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EventFlowService.publish', () => {
  it('thin-delegates to IEventBus.publish', async () => {
    const h = makeHarness();
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      {} as BridgeRegistry,
      false,
    );
    const e = event();
    await flow.publish(e as never);
    expect(h.bus.calls).toHaveLength(1);
    expect(h.bus.calls[0]![0]).toBe(e);
    expect(h.bus.calls[0]![1]).toBeUndefined();
    // No tx, no start, no bridge writes.
    expect(h.txInvocations).toBe(0);
    expect(h.startSpy).not.toHaveBeenCalled();
    expect(h.repo.getDeliveriesForEvent(EVENT_ID)).toHaveLength(0);
  });
});

describe('EventFlowService.publishAndStart — Case A (no registry match)', () => {
  it('writes outbox + starts job; no bridge_delivery row; one tx', async () => {
    const h = makeHarness({ spawnedRunId: 'run-A' });
    // Registry has a trigger for EVENT_TYPE but for a DIFFERENT job type.
    const reg = registryWith({ triggerId: 'other_job#0', jobKey: 'other_job' });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      false,
    );

    const result = await flow.publishAndStart(event() as never, JOB_KEY, { contactId: 'c1' });

    expect(result).toEqual({ runId: 'run-A' });
    expect(h.txInvocations).toBe(1);
    expect(h.bus.calls).toHaveLength(1);
    expect(h.startSpy).toHaveBeenCalledTimes(1);
    // tx was threaded through to both bus.publish and jobs.start.
    expect(h.bus.calls[0]![1]).toBeTruthy();
    expect(h.startSpy.mock.calls[0]![3]).toBeTruthy();
    // No bridge_delivery rows.
    expect(h.repo.getDeliveriesForEvent(EVENT_ID)).toHaveLength(0);
  });

  it("starts the run with trigger 'event', the caller's dedupeKey, over the facade's transaction", async () => {
    const h = makeHarness({ spawnedRunId: 'run-K' });
    const flow = new EventFlowService(h.db as never, h.bus as unknown as IEventBus, h.jobs, h.repo, {} as BridgeRegistry, false);
    await flow.publishAndStart(event() as never, JOB_KEY, { contactId: 'c1' }, { dedupeKey: 'contact:c1' });
    const [key, input, startOpts, tx] = h.startSpy.mock.calls[0]!;
    expect(key).toBe(JOB_KEY);
    expect(input).toEqual({ contactId: 'c1' });
    expect(startOpts).toEqual({ tenantId: null, trigger: 'event', dedupeKey: 'contact:c1' });
    expect(tx).toBe(h.bus.calls[0]![1]);
  });

  it('Case A — empty registry behaves identically', async () => {
    const h = makeHarness({ spawnedRunId: 'run-A2' });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      {} as BridgeRegistry,
      false,
    );
    const result = await flow.publishAndStart(event() as never, JOB_KEY, {});
    expect(result.runId).toBe('run-A2');
    expect(h.repo.getDeliveriesForEvent(EVENT_ID)).toHaveLength(0);
  });
});

describe('EventFlowService.publishAndStart — Case B (single matching trigger)', () => {
  it('pre-writes one delivered bridge_delivery row with userRunId', async () => {
    const h = makeHarness({ spawnedRunId: 'run-B' });
    const reg = registryWith({ triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      false,
    );

    const result = await flow.publishAndStart(event() as never, JOB_KEY, { contactId: 'c1' });

    expect(result.runId).toBe('run-B');
    const deliveries = h.repo.getDeliveriesForEvent(EVENT_ID);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      eventId: EVENT_ID,
      triggerId: `${JOB_KEY}#0`,
      userRunId: 'run-B',
      status: 'delivered',
    });
    expect(deliveries[0]!.deliveredAt).toBeInstanceOf(Date);
  });

  it('downstream drain insert with same (eventId, triggerId) is dedup\'d', async () => {
    // Memory backend's UniqueConstraintError simulates the Drizzle ON CONFLICT
    // DO NOTHING that BRIDGE-4 implements.
    const h = makeHarness({ spawnedRunId: 'run-B' });
    const reg = registryWith({ triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      false,
    );
    await flow.publishAndStart(event() as never, JOB_KEY, {});

    // Simulate the drain's attempt at the same (eventId, triggerId).
    const dup = h.repo.insertDelivery({
      eventId: EVENT_ID,
      triggerId: `${JOB_KEY}#0`,
      status: 'pending',
    });
    expect(dup).rejects.toBeInstanceOf((await import('../../../../runtime/subsystems/bridge')).UniqueConstraintError);
  });
});

describe('EventFlowService.publishAndStart — Case B (multiple matching triggers)', () => {
  it('pre-writes ALL matching trigger rows (filter, not find) — pinned by lead 2026-04-22', async () => {
    const h = makeHarness({ spawnedRunId: 'run-B-multi' });
    // Two triggers in the registry pointing to the SAME (event, jobKey) pair.
    // Codegen DuplicateTriggerError should prevent this in real projects,
    // but the facade must be correct independent of codegen guarantees.
    const reg = registryWith(
      { triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY },
      { triggerId: `${JOB_KEY}#1`, jobKey: JOB_KEY },
    );
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      false,
    );

    await flow.publishAndStart(event() as never, JOB_KEY, {});

    const deliveries = h.repo.getDeliveriesForEvent(EVENT_ID);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.triggerId).sort()).toEqual([
      `${JOB_KEY}#0`,
      `${JOB_KEY}#1`,
    ]);
    // Both reference the same eager run id.
    expect(deliveries.every((d) => d.userRunId === 'run-B-multi')).toBe(true);
  });
});

describe('EventFlowService.publishAndStart — rollback semantics', () => {
  it('insertDelivery throw rolls back the per-event tx (db.transaction wrapping)', async () => {
    const h = makeHarness({
      spawnedRunId: 'run-rollback',
      insertDeliveryFails: true,
    });
    const reg = registryWith({ triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      false,
    );

    let caught: unknown;
    try {
      await flow.publishAndStart(event() as never, JOB_KEY, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('insertDelivery failure');
    // The harness flagged the tx callback as rolled back (re-thrown).
    expect(h.rolledBack).toBe(true);
    // Bus + jobs.start were called (they're inside the tx); their writes
    // would roll back in a real DB. The test pins that the throw
    // propagates AND our tx wrapper marked rolledBack — that's the
    // observable contract.
    expect(h.bus.calls).toHaveLength(1);
    expect(h.startSpy).toHaveBeenCalledTimes(1);
  });
});

describe('EventFlowService.publishAndStart — multi-tenancy', () => {
  it('throws MissingTenantIdError when multiTenant=true and tenantId is undefined', async () => {
    const h = makeHarness();
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      {} as BridgeRegistry,
      true, // multi-tenant
    );
    expect(
      flow.publishAndStart(event() as never, JOB_KEY, {}),
    ).rejects.toBeInstanceOf(MissingTenantIdError);
    // Throw is at function entry — no DB writes happened.
    expect(h.txInvocations).toBe(0);
    expect(h.bus.calls).toHaveLength(0);
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it('passes explicit null tenantId through (cross-tenant work)', async () => {
    const h = makeHarness({ spawnedRunId: 'run-null-tenant' });
    const reg = registryWith({ triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      true,
    );
    await flow.publishAndStart(event() as never, JOB_KEY, {}, { tenantId: null });
    expect(h.startSpy.mock.calls[0]![2]).toMatchObject({ tenantId: null });
    const deliveries = h.repo.getDeliveriesForEvent(EVENT_ID);
    expect(deliveries[0]!.tenantId).toBeNull();
  });

  it('passes explicit string tenantId through to both eager start AND bridge_delivery', async () => {
    const h = makeHarness({ spawnedRunId: 'run-tenant-9' });
    const reg = registryWith({ triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      true,
    );
    await flow.publishAndStart(event() as never, JOB_KEY, {}, { tenantId: 'tenant-9' });
    expect(h.startSpy.mock.calls[0]![2]).toMatchObject({ tenantId: 'tenant-9' });
    const deliveries = h.repo.getDeliveriesForEvent(EVENT_ID);
    expect(deliveries[0]!.tenantId).toBe('tenant-9');
  });
});

describe('EventFlowService.publishAndStart — call ordering inside tx', () => {
  it('invokes bus.publish, then jobs.start, then bridgeRepo.insertDelivery', async () => {
    const order: string[] = [];
    const h = makeHarness({ spawnedRunId: 'run-order' });
    h.bus.publish = mock(async () => {
      order.push('bus.publish');
    });
    h.startSpy.mockImplementation(async () => {
      order.push('jobs.start');
      return started('run-order');
    });
    const origInsert = h.repo.insertDelivery.bind(h.repo);
    h.repo.insertDelivery = (async (row, tx) => {
      order.push('repo.insertDelivery');
      return origInsert(row, tx);
    }) as never;

    const reg = registryWith({ triggerId: `${JOB_KEY}#0`, jobKey: JOB_KEY });
    const flow = new EventFlowService(
      h.db as never,
      h.bus as unknown as IEventBus,
      h.jobs,
      h.repo,
      reg,
      false,
    );
    await flow.publishAndStart(event() as never, JOB_KEY, {});
    expect(order).toEqual(['bus.publish', 'jobs.start', 'repo.insertDelivery']);
  });
});
