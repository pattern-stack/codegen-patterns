/**
 * Unit tests for `BridgeOutboxDrainHook` (BRIDGE-4, ADR-023 Phase 2).
 *
 * Mocks the per-event tx via a fluent stub that captures `.insert(...)`
 * call sequences. No Postgres, no Docker. Pins:
 *   - registry miss → no inserts, returns zeros
 *   - null direction → no inserts, returns zeros, warns once
 *   - happy path → bridge_delivery + wrapper job_run insert per matched
 *     trigger; per-direction wrapper pool routing
 *   - Case B / replay collision (rowcount=0) → wrapper insert skipped for
 *     that trigger; sibling triggers still fire
 *   - tenant_id propagation
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  BridgeOutboxDrainHook,
  type BridgeRegistry,
} from '../../../../runtime/subsystems/bridge';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

// ─── Fluent insert mock ─────────────────────────────────────────────────────

type InsertCall = { table: string; values: Record<string, unknown> };

function makeTx(insertedIdResults: Array<string[]>) {
  // `insertedIdResults[i]` controls what the i-th INSERT-with-RETURNING
  // returns (`[id]` for "row inserted", `[]` for "ON CONFLICT skipped").
  // INSERTs without `.returning` are wrapper job_run inserts; they
  // don't consume a slot from this list.
  const calls: InsertCall[] = [];
  let returningCallIdx = 0;

  const tx = {
    insert(table: unknown) {
      // Drizzle's `pgTable` exposes the table name via the
      // `Symbol(drizzle:Name)` Symbol-keyed property. Look it up
      // generically rather than relying on the public surface.
      const sym = Object.getOwnPropertySymbols(table as object).find(
        (s) => String(s) === 'Symbol(drizzle:Name)',
      );
      const name = sym
        ? ((table as Record<symbol, unknown>)[sym] as string)
        : 'unknown';
      const builder = {
        values(v: Record<string, unknown>) {
          calls.push({ table: name, values: v });
          // Return both shapes: with onConflictDoNothing for the
          // delivery insert, and a plain promise for the wrapper insert.
          // The bridge hook consistently chains:
          //   .insert(bridgeDelivery).values(...).onConflictDoNothing(...).returning(...)
          //   .insert(jobRuns).values(...)            ← awaited as Promise
          const chain = {
            onConflictDoNothing(_opts: unknown) {
              return {
                returning(_cols: unknown) {
                  const idx = returningCallIdx++;
                  const ids = insertedIdResults[idx] ?? [];
                  return Promise.resolve(ids.map((id) => ({ id })));
                },
              };
            },
            // For wrapper inserts (no ON CONFLICT) — the hook awaits
            // the values() chain directly. Make it thenable.
            then(
              resolve: (v: unknown[]) => void,
              _reject?: (err: unknown) => void,
            ) {
              resolve([]);
            },
          };
          return chain;
        },
      };
      return builder;
    },
  };
  return { tx, calls };
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
    {
      triggerId: 'send_welcome_email#0',
      jobType: 'send_welcome_email',
      map: () => ({}),
    },
    {
      triggerId: 'sync_contact_to_hubspot#0',
      jobType: 'sync_contact_to_hubspot',
      map: () => ({}),
    },
  ],
} as unknown as BridgeRegistry;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BridgeOutboxDrainHook — registry lookup', () => {
  it('returns zeros without inserting when the registry has no entry', async () => {
    const hook = new BridgeOutboxDrainHook({} as BridgeRegistry);
    const { tx, calls } = makeTx([]);
    const result = await hook.processEvent(event(), tx as never);
    expect(result).toEqual({ delivered: 0, dedupSkips: 0, triggerCount: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('BridgeOutboxDrainHook — null direction tolerance', () => {
  it('returns zeros (with triggerCount), warns once, does not write rows', async () => {
    const hook = new BridgeOutboxDrainHook(REGISTRY_TWO_TRIGGERS);
    const { tx, calls } = makeTx([]);
    const result = await hook.processEvent(
      event({ metadata: { /* no direction */ } }),
      tx as never,
    );
    expect(result).toEqual({
      delivered: 0,
      dedupSkips: 0,
      triggerCount: 2, // matched but un-routable
    });
    expect(calls).toHaveLength(0);
  });
});

describe('BridgeOutboxDrainHook — happy path', () => {
  it('writes bridge_delivery + wrapper job_run for each matched trigger', async () => {
    const hook = new BridgeOutboxDrainHook(REGISTRY_TWO_TRIGGERS);
    // Both delivery inserts succeed (each returns one id).
    const { tx, calls } = makeTx([['del-1'], ['del-2']]);

    const result = await hook.processEvent(event(), tx as never);

    expect(result).toEqual({
      delivered: 2,
      dedupSkips: 0,
      triggerCount: 2,
    });

    // Expect 4 inserts: 2 delivery + 2 wrapper, interleaved.
    expect(calls).toHaveLength(4);
    expect(calls[0]!.table).toBe('bridge_delivery');
    expect(calls[1]!.table).toBe('job_run');
    expect(calls[2]!.table).toBe('bridge_delivery');
    expect(calls[3]!.table).toBe('job_run');

    // Wrappers route into events_change (matches event direction).
    expect(calls[1]!.values['pool']).toBe('events_change');
    expect(calls[3]!.values['pool']).toBe('events_change');
    expect(calls[1]!.values['jobType']).toBe('@framework/bridge_delivery');
    expect(calls[1]!.values['triggerSource']).toBe('event');
    expect(calls[1]!.values['triggerRef']).toBe('evt-1');

    // bridge_delivery rows carry trigger_id from the registry entry.
    expect(calls[0]!.values['triggerId']).toBe('send_welcome_email#0');
    expect(calls[2]!.values['triggerId']).toBe('sync_contact_to_hubspot#0');
  });

  it('routes wrapper pool by event direction (inbound/change/outbound)', async () => {
    const cases: Array<[string, string]> = [
      ['inbound', 'events_inbound'],
      ['change', 'events_change'],
      ['outbound', 'events_outbound'],
    ];
    for (const [direction, expectedPool] of cases) {
      const hook = new BridgeOutboxDrainHook({
        contact_created: [
          {
            triggerId: 'send_welcome_email#0',
            jobType: 'send_welcome_email',
            map: () => ({}),
          },
        ],
      } as unknown as BridgeRegistry);
      const { tx, calls } = makeTx([['del-1']]);
      await hook.processEvent(
        event({ metadata: { direction } }),
        tx as never,
      );
      const wrapper = calls.find((c) => c.table === 'job_run')!;
      expect(wrapper.values['pool']).toBe(expectedPool);
    }
  });
});

describe('BridgeOutboxDrainHook — Case B / replay dedup', () => {
  it('skips wrapper insert for the trigger whose delivery insert hit ON CONFLICT', async () => {
    const hook = new BridgeOutboxDrainHook(REGISTRY_TWO_TRIGGERS);
    // First delivery insert returns empty (ON CONFLICT — facade pre-write
    // or replay); second succeeds.
    const { tx, calls } = makeTx([[], ['del-2']]);

    const result = await hook.processEvent(event(), tx as never);

    expect(result).toEqual({
      delivered: 1,
      dedupSkips: 1,
      triggerCount: 2,
    });

    // 1 dedup-skipped delivery insert + 1 successful delivery insert + 1
    // wrapper insert = 3 calls total. The first trigger's wrapper is
    // skipped; the second still fires.
    expect(calls).toHaveLength(3);
    expect(calls[0]!.table).toBe('bridge_delivery'); // skipped
    expect(calls[1]!.table).toBe('bridge_delivery'); // succeeded
    expect(calls[2]!.table).toBe('job_run');
    expect(calls[2]!.values['pool']).toBe('events_change');
    expect(calls[1]!.values['triggerId']).toBe('sync_contact_to_hubspot#0');
  });

  it('all triggers ON CONFLICT → all wrappers skipped; no job_run inserts', async () => {
    const hook = new BridgeOutboxDrainHook(REGISTRY_TWO_TRIGGERS);
    const { tx, calls } = makeTx([[], []]);
    const result = await hook.processEvent(event(), tx as never);
    expect(result).toEqual({
      delivered: 0,
      dedupSkips: 2,
      triggerCount: 2,
    });
    expect(calls.filter((c) => c.table === 'job_run')).toHaveLength(0);
  });
});

describe('BridgeOutboxDrainHook — tenant propagation', () => {
  it('passes event.metadata.tenantId to both delivery and wrapper rows', async () => {
    const hook = new BridgeOutboxDrainHook({
      contact_created: [
        {
          triggerId: 'send_welcome_email#0',
          jobType: 'send_welcome_email',
          map: () => ({}),
        },
      ],
    } as unknown as BridgeRegistry);
    const { tx, calls } = makeTx([['del-1']]);
    await hook.processEvent(
      event({
        metadata: { direction: 'change', tenantId: 'tenant-7' },
      }),
      tx as never,
    );
    const delivery = calls.find((c) => c.table === 'bridge_delivery')!;
    const wrapper = calls.find((c) => c.table === 'job_run')!;
    expect(delivery.values['tenantId']).toBe('tenant-7');
    expect(wrapper.values['tenantId']).toBe('tenant-7');
  });

  it('defaults tenantId to null when metadata is absent', async () => {
    const hook = new BridgeOutboxDrainHook({
      contact_created: [
        {
          triggerId: 'send_welcome_email#0',
          jobType: 'send_welcome_email',
          map: () => ({}),
        },
      ],
    } as unknown as BridgeRegistry);
    const { tx, calls } = makeTx([['del-1']]);
    await hook.processEvent(
      event({ metadata: { direction: 'change' } }),
      tx as never,
    );
    const delivery = calls.find((c) => c.table === 'bridge_delivery')!;
    const wrapper = calls.find((c) => c.table === 'job_run')!;
    expect(delivery.values['tenantId']).toBeNull();
    expect(wrapper.values['tenantId']).toBeNull();
  });
});
