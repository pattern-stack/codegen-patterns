/**
 * Unit tests for `BridgeDeliveryHandler` (BRIDGE-5, ADR-023 Phase 2).
 *
 * Wires the handler against `MemoryBridgeDeliveryRepo` (BRIDGE-3),
 * `MemoryEventBus` (EVT-5, with `findById` from BRIDGE-5), and a small
 * stub `IJobOrchestrator` + `JobContext` so the handler logic can be
 * exercised without spinning up the full job-worker machinery. Full
 * end-to-end fanout (drain → wrapper → user job) is covered by BRIDGE-4
 * + BRIDGE-8 integration tests.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  BRIDGE_DELIVERY_JOB_TYPE,
  BridgeDeliveryHandler,
  MemoryBridgeDeliveryRepo,
  MissingTenantIdError,
  type BridgeDeliveryInput,
  type BridgeRegistry,
  type IJobBridge,
} from '../../../../runtime/subsystems/bridge';
import { MemoryEventBus } from '../../../../runtime/subsystems/events/event-bus.memory-backend';
import type {
  IJobOrchestrator,
  JobRun,
} from '../../../../runtime/subsystems/jobs/job-orchestrator.protocol';
import type {
  JobContext,
  JobHandlerBase,
} from '../../../../runtime/subsystems/jobs/job-handler.base';

// ─── Test infrastructure ────────────────────────────────────────────────────

const EVENT_ID = '00000000-0000-0000-0000-0000000000aa';
const EVENT_TYPE = 'contact_created' as const;
const TRIGGER_ID = 'send_welcome_email#0';

function publishedEvent(overrides: Partial<{
  id: string;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    id: overrides.id ?? EVENT_ID,
    type: EVENT_TYPE,
    aggregateId: 'contact-1',
    aggregateType: 'contact',
    payload: overrides.payload ?? {
      accountId: null,
      contactId: 'contact-1',
      createdBy: 'system',
    },
    occurredAt: new Date('2026-04-22T00:00:00Z'),
    metadata: { direction: 'change', pool: 'events_change' },
  };
}

function makeOrchestratorStub(spawned: Partial<JobRun> = {}): {
  orchestrator: IJobOrchestrator;
  startSpy: ReturnType<typeof mock>;
  lastSpawn?: { type: string; input: unknown; opts?: unknown };
} {
  const calls: Array<{ type: string; input: unknown; opts?: unknown }> = [];
  const startSpy = mock(
    async (type: string, input: unknown, opts?: unknown): Promise<JobRun> => {
      calls.push({ type, input, opts });
      return {
        id: spawned.id ?? randomUUID(),
        jobType: type,
        jobVersion: 1,
        parentRunId: (opts as { parentRunId?: string })?.parentRunId ?? null,
        rootRunId: spawned.rootRunId ?? randomUUID(),
        parentClosePolicy: 'terminate',
        scopeEntityType: null,
        scopeEntityId: null,
        tenantId:
          (opts as { tenantId?: string | null })?.tenantId ?? null,
        tags: {},
        pool: 'outbound_email',
        priority: 0,
        concurrencyKey: null,
        dedupeKey: null,
        status: 'pending',
        input: input as Record<string, unknown>,
        output: null,
        error: null,
        triggerSource:
          ((opts as { triggerSource?: string })?.triggerSource as
            | 'event'
            | 'manual'
            | 'schedule'
            | 'parent') ?? 'manual',
        triggerRef: (opts as { triggerRef?: string })?.triggerRef ?? null,
        runAt: new Date(),
        startedAt: null,
        finishedAt: null,
        claimedAt: null,
        attempts: 0,
        waitKind: null,
        resumeToken: null,
        waitDeadline: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  );
  const orchestrator: IJobOrchestrator = {
    start: startSpy as unknown as IJobOrchestrator['start'],
    cancel: mock(async () => undefined),
    replay: mock(async () => {
      throw new Error('not implemented');
    }),
    upsertJobRows: mock(async () => ({ orphaned: [] })),
  };
  return {
    orchestrator,
    startSpy,
    get lastSpawn() {
      return calls[calls.length - 1];
    },
  };
}

/**
 * Minimal `JobContext` for unit testing handler logic. `step` is a thin
 * memoization layer keyed by `stepId` so retry-after-success tests can
 * verify the cached value is returned without re-running the fn.
 */
function makeCtx<TInput>(input: TInput): {
  ctx: JobContext<TInput>;
  stepCalls: Map<string, number>;
} {
  const cache = new Map<string, unknown>();
  const stepCalls = new Map<string, number>();
  const ctx: JobContext<TInput> = {
    input,
    run: { id: 'wrapper-run-id' } as JobRun,
    async step<TOutput>(stepId: string, fn: () => Promise<TOutput>) {
      stepCalls.set(stepId, (stepCalls.get(stepId) ?? 0) + 1);
      if (cache.has(stepId)) return cache.get(stepId) as TOutput;
      const out = await fn();
      cache.set(stepId, out);
      return out;
    },
    async spawnChild() {
      throw new Error('not used in BRIDGE-5 tests');
    },
    logger: { error: () => undefined } as unknown as JobContext<TInput>['logger'],
  };
  return { ctx, stepCalls };
}

// ─── Fixtures: registry shapes the handler will look up against ─────────────

function registryFor(
  entry: { triggerId: string; jobType: string; map?: Function; when?: Function } = {
    triggerId: TRIGGER_ID,
    jobType: 'send_welcome_email',
  },
): BridgeRegistry {
  return {
    [EVENT_TYPE]: [
      {
        triggerId: entry.triggerId,
        jobType: entry.jobType,
        map:
          (entry.map as (e: unknown) => unknown) ??
          ((e: { aggregateId: string }) => ({ contactId: e.aggregateId })),
        when: entry.when as ((e: unknown) => boolean) | undefined,
      },
    ],
  } as unknown as BridgeRegistry;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BridgeDeliveryHandler — happy path', () => {
  let bus: MemoryEventBus;
  let repo: MemoryBridgeDeliveryRepo;

  beforeEach(() => {
    bus = new MemoryEventBus();
    repo = new MemoryBridgeDeliveryRepo();
  });

  it('looks up delivery, evaluates registry, spawns user job, marks delivered', async () => {
    await bus.publish(publishedEvent());

    const deliveryId = randomUUID();
    await repo.insertDelivery({
      id: deliveryId,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      wrapperRunId: 'wrapper-run-id',
      userRunId: null,
      status: 'pending',
      tenantId: null,
    });

    const { orchestrator, startSpy } = makeOrchestratorStub({
      id: 'spawned-run-id',
    });
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor(),
      false,
    );
    const { ctx, stepCalls } = makeCtx<BridgeDeliveryInput>({ deliveryId });

    const result = await handler.run(ctx);

    expect(result).toEqual({ runId: 'spawned-run-id' });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stepCalls.get('spawn_user_run')).toBe(1);

    const startArgs = startSpy.mock.calls[0]!;
    expect(startArgs[0]).toBe('send_welcome_email');
    expect(startArgs[1]).toEqual({ contactId: 'contact-1' });
    expect(startArgs[2]).toMatchObject({
      parentRunId: 'wrapper-run-id',
      triggerSource: 'event',
      triggerRef: EVENT_ID,
      tenantId: null,
    });

    const after = await repo.findDeliveryById(deliveryId);
    expect(after?.status).toBe('delivered');
    expect(after?.userRunId).toBe('spawned-run-id');
    expect(after?.deliveredAt).toBeInstanceOf(Date);
  });
});

describe('BridgeDeliveryHandler — skip paths', () => {
  let bus: MemoryEventBus;
  let repo: MemoryBridgeDeliveryRepo;

  beforeEach(() => {
    bus = new MemoryEventBus();
    repo = new MemoryBridgeDeliveryRepo();
  });

  async function seed(deliveryId: string) {
    await bus.publish(publishedEvent());
    await repo.insertDelivery({
      id: deliveryId,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      wrapperRunId: 'wrapper-run-id',
      userRunId: null,
      status: 'pending',
      tenantId: null,
    });
  }

  it('marks skipped/trigger_unregistered when registry has no matching entry', async () => {
    const deliveryId = randomUUID();
    await seed(deliveryId);

    const { orchestrator, startSpy } = makeOrchestratorStub();
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      // registry has a different triggerId
      registryFor({ triggerId: 'something_else#0', jobType: 'x' }),
      false,
    );
    const { ctx } = makeCtx<BridgeDeliveryInput>({ deliveryId });

    const result = await handler.run(ctx);

    expect(result).toEqual({ skipped: true, reason: 'trigger_unregistered' });
    expect(startSpy).not.toHaveBeenCalled();
    const after = await repo.findDeliveryById(deliveryId);
    expect(after?.status).toBe('skipped');
    expect(after?.skipReason).toBe('trigger_unregistered');
  });

  it('marks skipped/predicate_false when when: returns false', async () => {
    const deliveryId = randomUUID();
    await seed(deliveryId);

    const { orchestrator, startSpy } = makeOrchestratorStub();
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor({
        triggerId: TRIGGER_ID,
        jobType: 'send_welcome_email',
        when: () => false,
      }),
      false,
    );
    const { ctx } = makeCtx<BridgeDeliveryInput>({ deliveryId });

    const result = await handler.run(ctx);

    expect(result).toEqual({ skipped: true, reason: 'predicate_false' });
    expect(startSpy).not.toHaveBeenCalled();
    const after = await repo.findDeliveryById(deliveryId);
    expect(after?.status).toBe('skipped');
    expect(after?.skipReason).toBe('predicate_false');
  });

  it('marks skipped/event_row_missing when domain_events row is gone', async () => {
    const deliveryId = randomUUID();
    // Delivery row exists but we never publish the event
    await repo.insertDelivery({
      id: deliveryId,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      wrapperRunId: 'wrapper-run-id',
      userRunId: null,
      status: 'pending',
      tenantId: null,
    });

    const { orchestrator, startSpy } = makeOrchestratorStub();
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor(),
      false,
    );
    const { ctx } = makeCtx<BridgeDeliveryInput>({ deliveryId });

    const result = await handler.run(ctx);

    expect(result).toEqual({ skipped: true, reason: 'event_row_missing' });
    expect(startSpy).not.toHaveBeenCalled();
    const after = await repo.findDeliveryById(deliveryId);
    expect(after?.status).toBe('skipped');
    expect(after?.skipReason).toBe('event_row_missing');
  });

  it('returns skipped/delivery_row_missing without throwing when delivery id is unknown', async () => {
    const { orchestrator, startSpy } = makeOrchestratorStub();
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor(),
      false,
    );
    const { ctx } = makeCtx<BridgeDeliveryInput>({ deliveryId: 'unknown' });
    const result = await handler.run(ctx);
    expect(result).toEqual({ skipped: true, reason: 'delivery_row_missing' });
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('BridgeDeliveryHandler — replay safety (step memoization)', () => {
  it('on retry returns the cached spawn output and does not re-call orchestrator.start', async () => {
    const bus = new MemoryEventBus();
    const repo = new MemoryBridgeDeliveryRepo();
    await bus.publish(publishedEvent());
    const deliveryId = randomUUID();
    await repo.insertDelivery({
      id: deliveryId,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      wrapperRunId: 'wrapper-run-id',
      userRunId: null,
      status: 'pending',
      tenantId: null,
    });

    const { orchestrator, startSpy } = makeOrchestratorStub({ id: 'run-1' });
    const { ctx, stepCalls } = makeCtx<BridgeDeliveryInput>({ deliveryId });
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor(),
      false,
    );

    // First attempt — would normally markDelivered; reset the row to
    // pending after step memoization records the spawn cache, then re-run
    // the handler to simulate a retry that hits the memoized step.
    await handler.run(ctx);
    // Re-set delivery to pending to detect a double-spawn:
    await repo.markSkipped(deliveryId, 'reset_for_test');
    // Also clear the userRunId — markSkipped doesn't touch it, but the
    // assertion is on call count.
    await handler.run(ctx);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stepCalls.get('spawn_user_run')).toBe(2); // step invoked twice; fn called once
  });
});

describe('BridgeDeliveryHandler — multi-tenancy', () => {
  it('throws MissingTenantIdError when multiTenant=true and tenantId is undefined', async () => {
    const bus = new MemoryEventBus();
    const repo = new MemoryBridgeDeliveryRepo();
    await bus.publish(publishedEvent());

    const deliveryId = randomUUID();
    // Insert with explicit `undefined` (the in-memory backend allows this
    // even though the DB column is NULLable; the handler-level guard is
    // belt-and-suspenders for fixtures + future protocol changes).
    await repo.insertDelivery({
      id: deliveryId,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      status: 'pending',
    });
    // Force tenantId === undefined on the in-memory record
    const rec = await repo.findDeliveryById(deliveryId);
    (rec as unknown as { tenantId?: string | null }).tenantId = undefined;

    const { orchestrator } = makeOrchestratorStub();
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor(),
      true, // multi-tenant ON
    );
    const { ctx } = makeCtx<BridgeDeliveryInput>({ deliveryId });

    expect(handler.run(ctx)).rejects.toBeInstanceOf(MissingTenantIdError);
  });

  it('passes explicit null tenantId through to orchestrator.start', async () => {
    const bus = new MemoryEventBus();
    const repo = new MemoryBridgeDeliveryRepo();
    await bus.publish(publishedEvent());

    const deliveryId = randomUUID();
    await repo.insertDelivery({
      id: deliveryId,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      status: 'pending',
      tenantId: null,
    });

    const { orchestrator, startSpy } = makeOrchestratorStub();
    const handler = new BridgeDeliveryHandler(
      repo,
      orchestrator,
      bus,
      registryFor(),
      true,
    );
    const { ctx } = makeCtx<BridgeDeliveryInput>({ deliveryId });

    await handler.run(ctx);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]![2]).toMatchObject({ tenantId: null });
  });
});

describe('BridgeDeliveryHandler — registration metadata', () => {
  it('declares the canonical job type and is a JobHandlerBase subclass', () => {
    expect(BRIDGE_DELIVERY_JOB_TYPE).toBe('@framework/bridge_delivery');
    // BridgeDeliveryHandler extends JobHandlerBase — type-level check via
    // construction; sufficient that it instantiates.
    const inst: JobHandlerBase<BridgeDeliveryInput, unknown> = new BridgeDeliveryHandler(
      new MemoryBridgeDeliveryRepo(),
      makeOrchestratorStub().orchestrator,
      new MemoryEventBus(),
      {} as BridgeRegistry,
      false,
    );
    expect(typeof inst.run).toBe('function');
  });
});
