/**
 * Unit tests for `BridgeOutboxDrainHook` (ADR-023, JOBS-3).
 *
 * The per-event transaction is a fluent stub that records the `bridge_delivery` writes; `JobStarter` is a fake that
 * records each start. No Postgres. Pins:
 *   - registry miss → no writes, zeros
 *   - happy path → per trigger, in the event's transaction: the delivery row, `start(jobKey, map(event),
 *     { tenantId, trigger: 'event' }, tx)`, then the delivery marked `delivered` with the run's id
 *   - replay / Case B (the delivery insert hits ON CONFLICT) → no start for that trigger; siblings still start
 *   - a trigger whose job this process doesn't register → `skipped` / `trigger_unregistered`, no start
 *   - `when` false → `skipped` / `predicate_false`, no start
 *   - tenant propagation; a trigger that cannot start fails alone (its delivery `failed`, its siblings started)
 *   - a trigger's `dedupeKey` reaches the start
 *   - the boot check: a trigger naming a job this app doesn't register stops the boot
 *   - the audit-tier guard
 */
import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';

import {
  BridgeOutboxDrainHook,
  type BridgeRegistry,
} from '../../../../runtime/subsystems/bridge';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';
import type { JobStarter } from '../../../../runtime/subsystems/jobs/job-starter';

// ─── Fakes ──────────────────────────────────────────────────────────────────

type InsertCall = { table: string; values: Record<string, unknown> };
type UpdateCall = { table: string; set: Record<string, unknown> };

function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s) === 'Symbol(drizzle:Name)');
  return sym ? ((table as Record<symbol, unknown>)[sym] as string) : 'unknown';
}

/** `insertedIdResults[i]` is what the i-th delivery insert returns: `[id]` inserted, `[]` ON CONFLICT skipped. */
function makeTx(insertedIdResults: Array<string[]>) {
  const calls: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  let idx = 0;
  const tx: Record<string, unknown> = {
    // A trigger's savepoint: the fake runs it on the same stub (a throw inside rolls nothing back here; the hook's
    // handling of it is what is under test).
    transaction<T>(fn: (sp: unknown) => Promise<T>): Promise<T> {
      return fn(tx);
    },
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          calls.push({ table: tableName(table), values: v });
          return {
            onConflictDoNothing(_opts: unknown) {
              return {
                returning(_cols: unknown) {
                  const ids = insertedIdResults[idx++] ?? [];
                  return Promise.resolve(ids.map((id) => ({ id })));
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(set: Record<string, unknown>) {
          return {
            where(_cond: unknown) {
              updates.push({ table: tableName(table), set });
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
  return { tx, calls, updates };
}

type StartCall = { jobKey: string; input: unknown; options: Record<string, unknown>; tx: unknown };

/** A `JobStarter` that registers `registered` (default: every key) and records each start. */
function fakeStarter(opts: { registered?: string[]; fail?: Error } = {}) {
  const starts: StartCall[] = [];
  const starter = {
    has: (key: string) => opts.registered?.includes(key) ?? true,
    async start(jobKey: string, input: unknown, options: Record<string, unknown> = {}, tx?: unknown) {
      if (opts.fail) throw opts.fail;
      starts.push({ jobKey, input, options, tx });
      return { run: { id: `run-${starts.length}` }, created: true };
    },
  } as unknown as JobStarter;
  return { starter, starts };
}

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'evt-1',
    type: 'contact_created',
    aggregateId: 'agg-1',
    aggregateType: 'contact',
    payload: {},
    occurredAt: new Date('2026-04-22T00:00:00Z'),
    metadata: { direction: 'change' },
    ...overrides,
  };
}

const REGISTRY_TWO_TRIGGERS: BridgeRegistry = {
  contact_created: [
    { triggerId: 'send_welcome_email#0', jobKey: 'send_welcome_email', map: (e: DomainEvent) => ({ id: e.aggregateId }) },
    { triggerId: 'integration_contact_to_hubspot#0', jobKey: 'integration_contact_to_hubspot', map: () => ({}) },
  ],
} as unknown as BridgeRegistry;

const ZERO = { delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 0 };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BridgeOutboxDrainHook — registry lookup', () => {
  it('returns zeros without writing or starting when the registry has no entry', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, {} as BridgeRegistry);
    const { tx, calls } = makeTx([]);
    expect(await hook.processEvent(event(), tx as never)).toEqual(ZERO);
    expect(calls).toHaveLength(0);
    expect(starts).toHaveLength(0);
  });
});

describe('BridgeOutboxDrainHook — happy path', () => {
  it('per trigger, in the event transaction: the delivery row, the run started, the delivery marked delivered', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const { tx, calls, updates } = makeTx([['del-1'], ['del-2']]);

    const result = await hook.processEvent(event(), tx as never);

    expect(result).toEqual({ delivered: 2, dedupSkips: 0, triggerCount: 2, auditBlocked: 0 });
    expect(calls.map((c) => [c.table, c.values.triggerId, c.values.status])).toEqual([
      ['bridge_delivery', 'send_welcome_email#0', 'pending'],
      ['bridge_delivery', 'integration_contact_to_hubspot#0', 'pending'],
    ]);
    expect(calls[0]!.values.eventId).toBe('evt-1');
    // The user's run, started inside the event's transaction (a savepoint of it), trigger 'event'.
    expect(starts.map((s) => s.jobKey)).toEqual(['send_welcome_email', 'integration_contact_to_hubspot']);
    expect(starts[0]!.input).toEqual({ id: 'agg-1' });
    expect(starts[0]!.options).toEqual({ tenantId: null, trigger: 'event' });
    expect(starts.every((s) => s.tx === tx)).toBe(true);
    // No dedupe key unless the trigger declares one; never a window on the bridge path.
    expect(starts.some((s) => 'dedupeKey' in s.options || 'dedupeWindowMs' in s.options)).toBe(false);
    expect(updates.map((u) => [u.set.status, u.set.userRunId])).toEqual([
      ['delivered', 'run-1'],
      ['delivered', 'run-2'],
    ]);
  });
});

describe('BridgeOutboxDrainHook — replay / Case B dedup', () => {
  it('a delivery that hits ON CONFLICT starts nothing for that trigger; its sibling still starts', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const { tx, updates } = makeTx([[], ['del-2']]);

    const result = await hook.processEvent(event(), tx as never);

    expect(result).toEqual({ delivered: 1, dedupSkips: 1, triggerCount: 2, auditBlocked: 0 });
    expect(starts.map((s) => s.jobKey)).toEqual(['integration_contact_to_hubspot']);
    expect(updates).toHaveLength(1);
  });

  it('every delivery ON CONFLICT (an outbox replay) → no run started', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const result = await hook.processEvent(event(), makeTx([[], []]).tx as never);
    expect(result).toEqual({ delivered: 0, dedupSkips: 2, triggerCount: 2, auditBlocked: 0 });
    expect(starts).toHaveLength(0);
  });
});

describe('BridgeOutboxDrainHook — skips', () => {
  it("a trigger whose job this process doesn't register is skipped (trigger_unregistered), not started", async () => {
    const { starter, starts } = fakeStarter({ registered: ['integration_contact_to_hubspot'] });
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const { tx, updates } = makeTx([['del-1'], ['del-2']]);

    const result = await hook.processEvent(event(), tx as never);

    expect(result.delivered).toBe(1);
    expect(starts.map((s) => s.jobKey)).toEqual(['integration_contact_to_hubspot']);
    expect(updates[0]!.set).toEqual({ status: 'skipped', skipReason: 'trigger_unregistered' });
  });

  it('a trigger whose `when` is false is skipped (predicate_false), not started', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, {
      contact_created: [{ triggerId: 'x#0', jobKey: 'x', map: () => ({}), when: () => false }],
    } as unknown as BridgeRegistry);
    const { tx, updates } = makeTx([['del-1']]);

    expect((await hook.processEvent(event(), tx as never)).delivered).toBe(0);
    expect(starts).toHaveLength(0);
    expect(updates[0]!.set).toEqual({ status: 'skipped', skipReason: 'predicate_false' });
  });
});

describe('BridgeOutboxDrainHook — tenant propagation and failure', () => {
  it('passes event.metadata.tenantId to the delivery row and the start', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const { tx, calls } = makeTx([['del-1'], ['del-2']]);
    await hook.processEvent(event({ metadata: { direction: 'change', tenantId: 'tenant-a' } }), tx as never);
    expect(calls.every((c) => c.values.tenantId === 'tenant-a')).toBe(true);
    expect(starts.every((s) => s.options.tenantId === 'tenant-a')).toBe(true);
  });

  it('defaults the tenant to null (the starter makes it SYSTEM_TENANT) when metadata has none', async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const { tx, calls } = makeTx([['del-1'], ['del-2']]);
    await hook.processEvent(event({ metadata: {} }), tx as never);
    expect(calls.every((c) => c.values.tenantId === null)).toBe(true);
    expect(starts.every((s) => s.options.tenantId === null)).toBe(true);
  });

  it('a trigger that cannot start fails alone: its delivery failed with the error, its sibling started, no throw', async () => {
    const starts: StartCall[] = [];
    const starter = {
      has: () => true,
      async start(jobKey: string, input: unknown, options: Record<string, unknown> = {}, tx?: unknown) {
        if (jobKey === 'send_welcome_email') throw new Error('input refused');
        starts.push({ jobKey, input, options, tx });
        return { run: { id: 'run-ok' }, created: true };
      },
    } as unknown as JobStarter;
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    const { tx, updates } = makeTx([['del-1'], ['del-2']]);

    const result = await hook.processEvent(event(), tx as never);

    expect(result).toEqual({ delivered: 1, dedupSkips: 0, triggerCount: 2, auditBlocked: 0 });
    expect(starts.map((s) => s.jobKey)).toEqual(['integration_contact_to_hubspot']);
    expect(updates[0]!.set).toEqual({ status: 'failed', error: { type: 'Error', message: 'input refused' } });
    expect(updates[1]!.set).toMatchObject({ status: 'delivered', userRunId: 'run-ok' });
  });

  it("a trigger's dedupeKey reaches the start (the job's collision then applies)", async () => {
    const { starter, starts } = fakeStarter();
    const hook = new BridgeOutboxDrainHook(starter, {
      contact_created: [{ triggerId: 'sync#0', jobKey: 'sync', map: () => ({}), dedupeKey: (e: DomainEvent) => `sync:${e.aggregateId}` }],
    } as unknown as BridgeRegistry);
    await hook.processEvent(event(), makeTx([['del-1']]).tx as never);
    expect(starts[0]!.options).toEqual({ tenantId: null, trigger: 'event', dedupeKey: 'sync:agg-1' });
  });
});

describe('BridgeOutboxDrainHook — boot check', () => {
  it("stops the boot when a trigger names a job this app doesn't register", () => {
    const { starter } = fakeStarter({ registered: ['send_welcome_email'] });
    const hook = new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS);
    expect(() => hook.onApplicationBootstrap()).toThrow(
      /bridge triggers name jobs this app does not register: 'integration_contact_to_hubspot#0' → 'integration_contact_to_hubspot'/,
    );
  });

  it('passes when every trigger names a registered job', () => {
    const { starter } = fakeStarter();
    expect(() => new BridgeOutboxDrainHook(starter, REGISTRY_TWO_TRIGGERS).onApplicationBootstrap()).not.toThrow();
  });
});

// ─── Audit-tier guard (AUDIT-4) ──────────────────────────────────────────────

describe('BridgeOutboxDrainHook — audit-tier guard', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Spy on the NestJS Logger prototype since the hook constructs its own
    // private Logger instance. Reset between tests so per-test WARN counts
    // are isolated. (`spyOn` returns a persistent spy across tests; clear
    // the call log per test.)
    warnSpy = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    warnSpy.mockClear();
  });

  function auditEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
    return event({
      id: 'audit-evt-1',
      type: 'crm_sync_started',
      metadata: { tier: 'audit', pool: null, direction: null },
      ...overrides,
    });
  }

  // Drift registry: triggers registered against audit event types. AUDIT-2
  // codegen validation should make this impossible — these tests simulate the
  // out-of-band / version-skew drift the runtime guard is defense-in-depth for.
  const DRIFT_REGISTRY: BridgeRegistry = {
    crm_sync_started: [
      { triggerId: 'side_effect_job#0', jobKey: 'side_effect_job', map: () => ({}) },
    ],
    crm_sync_completed: [
      { triggerId: 'other_side_effect#0', jobKey: 'other_side_effect', map: () => ({}) },
    ],
  } as unknown as BridgeRegistry;

  it('blocks fanout when an audit event reaches an out-of-band trigger', async () => {
    // Out-of-band: registry has a trigger registered for an audit event
    // type (codegen-side AUDIT-2 should have prevented this — simulating
    // registry/runtime drift).
    const hook = new BridgeOutboxDrainHook(fakeStarter().starter, {
      crm_sync_started: [
        {
          triggerId: 'side_effect_job#0',
          jobKey: 'side_effect_job',
          map: () => ({}),
        },
      ],
    } as unknown as BridgeRegistry);
    const { tx, calls } = makeTx([]);

    const result = await hook.processEvent(auditEvent(), tx as never);

    expect(result).toEqual({
      delivered: 0,
      dedupSkips: 0,
      triggerCount: 0,
      auditBlocked: 1,
    });
    expect(calls).toHaveLength(0); // no bridge_delivery rows written
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]![0]);
    expect(message).toContain(
      "Bridge guard blocked audit-tier event 'crm_sync_started'",
    );
    expect(message).toContain('event.id=audit-evt-1');
    // The (now verified) drift claim names the offending trigger id.
    expect(message).toContain('side_effect_job#0');
    expect(message).toContain('Investigate registry/runtime drift.');
  });

  it('stays silent for an audit event with no registered trigger (benign shared-outbox case)', async () => {
    // The common case: an audit-tier lifecycle event (e.g. connection.created)
    // sharing the outbox with domain events. No trigger → no drift → no WARN.
    // This is the regression guard for the false-positive class.
    const hook = new BridgeOutboxDrainHook(fakeStarter().starter, {} as BridgeRegistry);
    const { tx, calls } = makeTx([]);

    const result = await hook.processEvent(auditEvent(), tx as never);

    expect(result).toEqual({
      delivered: 0,
      dedupSkips: 0,
      triggerCount: 0,
      auditBlocked: 0,
    });
    expect(calls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('dedups WARN per event type within a single process', async () => {
    const hook = new BridgeOutboxDrainHook(fakeStarter().starter, DRIFT_REGISTRY);

    const a = await hook.processEvent(auditEvent(), makeTx([]).tx as never);
    const b = await hook.processEvent(
      auditEvent({ id: 'audit-evt-2' }),
      makeTx([]).tx as never,
    );

    expect(a.auditBlocked).toBe(1);
    expect(b.auditBlocked).toBe(1);
    // Same event type → WARN only once across the two calls.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a fresh WARN when a different audit event type is seen', async () => {
    const hook = new BridgeOutboxDrainHook(fakeStarter().starter, DRIFT_REGISTRY);

    await hook.processEvent(auditEvent(), makeTx([]).tx as never);
    await hook.processEvent(
      auditEvent({ id: 'audit-evt-2', type: 'crm_sync_completed' }),
      makeTx([]).tx as never,
    );

    // Two distinct event types → WARN fires once per type.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0]![0])).toContain(
      "'crm_sync_started'",
    );
    expect(String(warnSpy.mock.calls[1]![0])).toContain(
      "'crm_sync_completed'",
    );
  });

  it('does not fire on domain events with valid triggers', async () => {
    const hook = new BridgeOutboxDrainHook(fakeStarter().starter, REGISTRY_TWO_TRIGGERS);
    const { tx } = makeTx([['del-1'], ['del-2']]);
    const result = await hook.processEvent(event(), tx as never);
    expect(result.auditBlocked).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not fire on domain events with no triggers', async () => {
    const hook = new BridgeOutboxDrainHook(fakeStarter().starter, {} as BridgeRegistry);
    const { tx } = makeTx([]);
    const result = await hook.processEvent(event(), tx as never);
    expect(result).toEqual({
      delivered: 0,
      dedupSkips: 0,
      triggerCount: 0,
      auditBlocked: 0,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
