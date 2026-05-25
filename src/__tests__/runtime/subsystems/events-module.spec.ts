/**
 * EventsModule unit tests (EVT-6).
 *
 * Verifies the `forRoot({ backend })` factory wires:
 *   - `EVENT_BUS` to the backend implementation
 *   - `TYPED_EVENT_BUS` to the generated `TypedEventBus` facade
 *   - `EVENTS_MULTI_TENANT` to the resolved boolean flag
 * and that `TypedEventBus.publish()` enforces tenantId when multi-tenant
 * mode is on.
 *
 * Memory backend only — Drizzle backend wiring is exercised in
 * `just test-family` / `just test-integration` (real Postgres).
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../../../runtime/subsystems/events/events.module';
import {
  EVENT_BUS,
  EVENT_READ_PORT,
  EVENTS_MULTI_TENANT,
  TYPED_EVENT_BUS,
} from '../../../../runtime/subsystems/events/events.tokens';
import { TypedEventBus } from '../../../../runtime/subsystems/events/generated/bus';
import { MemoryEventBus } from '../../../../runtime/subsystems/events/event-bus.memory-backend';
import { MissingTenantIdError } from '../../../../runtime/subsystems/events/events-errors';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

// Any registered event type works; the registry currently ships with
// `contact_created` — use it so payload validation (default on) is happy.
// Keep payload-validation warnings quiet — `contact_created`'s Zod schema
// wants UUIDs + a `createdBy`, and validation is on by default.
const EVENT_TYPE = 'contact_created' as const;
const PAYLOAD = {
  contactId: '11111111-1111-1111-1111-111111111111',
  accountId: '22222222-2222-2222-2222-222222222222',
  createdBy: '33333333-3333-3333-3333-333333333333',
} as const;

describe('EventsModule.forRoot({ backend: "memory" })', () => {
  it('resolves EVENT_BUS to MemoryEventBus and TYPED_EVENT_BUS to TypedEventBus', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    const bus = moduleRef.get(EVENT_BUS);
    const typed = moduleRef.get(TYPED_EVENT_BUS);

    expect(bus).toBeInstanceOf(MemoryEventBus);
    expect(typed).toBeInstanceOf(TypedEventBus);

    await moduleRef.close();
  });

  it('binds EVENT_READ_PORT to the same MemoryEventBus instance (OBS-LIST-1)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    const bus = moduleRef.get(EVENT_BUS);
    const readPort = moduleRef.get(EVENT_READ_PORT);
    // Read port is the same backend instance; it implements listEvents.
    expect(readPort).toBe(bus);
    expect(typeof (readPort as { listEvents: unknown }).listEvents).toBe('function');

    await moduleRef.close();
  });

  it('TYPED_EVENT_BUS and the TypedEventBus class resolve to the same instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    // Token and class both point at the same provider (useExisting aliasing).
    const byToken = moduleRef.get(TYPED_EVENT_BUS);
    const byClass = moduleRef.get(TypedEventBus);
    expect(byToken).toBe(byClass);

    await moduleRef.close();
  });

  it('defaults EVENTS_MULTI_TENANT to false when multiTenant is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(EVENTS_MULTI_TENANT)).toBe(false);

    await moduleRef.close();
  });

  it('resolves EVENTS_MULTI_TENANT to false when multiTenant: false is explicit', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory', multiTenant: false })],
    }).compile();

    expect(moduleRef.get(EVENTS_MULTI_TENANT)).toBe(false);

    await moduleRef.close();
  });

  it('resolves EVENTS_MULTI_TENANT to true when multiTenant: true', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory', multiTenant: true })],
    }).compile();

    expect(moduleRef.get(EVENTS_MULTI_TENANT)).toBe(true);

    await moduleRef.close();
  });

  it('is global: true so consumer modules see the tokens transitively', async () => {
    @Module({})
    class ConsumerModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        EventsModule.forRoot({ backend: 'memory' }),
        ConsumerModule,
      ],
    }).compile();

    // Resolving the token from the root module proves global registration.
    const typed = moduleRef.get(TYPED_EVENT_BUS);
    expect(typed).toBeInstanceOf(TypedEventBus);

    // The DynamicModule shape itself declares global: true.
    const dyn = EventsModule.forRoot({ backend: 'memory' });
    expect(dyn.global).toBe(true);

    await moduleRef.close();
  });

  it('TypedEventBus.publish() dispatches through the memory bus to subscribers (multiTenant: false)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    const typed = moduleRef.get(TYPED_EVENT_BUS) as TypedEventBus;
    const memoryBus = moduleRef.get(EVENT_BUS) as MemoryEventBus;

    const received: DomainEvent[] = [];
    memoryBus.subscribe(EVENT_TYPE, async (e) => { received.push(e); });

    await typed.publish(EVENT_TYPE, 'c-1', PAYLOAD);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe(EVENT_TYPE);
    expect(received[0]?.aggregateId).toBe('c-1');
    expect(received[0]?.payload).toEqual(PAYLOAD as unknown as Record<string, unknown>);
    // tenantId is NOT required when multiTenant is off; metadata still
    // gets the registry stamp but no tenantId is populated.
    expect(received[0]?.metadata?.['tenantId']).toBeUndefined();
    expect(received[0]?.metadata?.['pool']).toBe('events_change');

    await moduleRef.close();
  });

  it('TypedEventBus.publish() throws MissingTenantIdError when multiTenant: true and tenantId is absent', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory', multiTenant: true })],
    }).compile();

    const typed = moduleRef.get(TYPED_EVENT_BUS) as TypedEventBus;

    await expect(typed.publish(EVENT_TYPE, 'c-1', PAYLOAD)).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );

    // And when metadata exists but lacks tenantId:
    await expect(
      typed.publish(EVENT_TYPE, 'c-1', PAYLOAD, { metadata: { source: 'test' } }),
    ).rejects.toBeInstanceOf(MissingTenantIdError);

    await moduleRef.close();
  });

  // ---------------------------------------------------------------------------
  // AUDIT-3: tier stamping + audit-routing override behavior.
  //
  // Domain events stamp `metadata.tier = 'domain'` alongside pool/direction
  // from the registry. Audit events stamp `metadata.tier = 'audit'` and
  // FORCE pool/direction to null even if the caller supplied non-null
  // overrides in opts.metadata (silent override + debug-level log).
  // ---------------------------------------------------------------------------

  it('TypedEventBus.publish() stamps tier=domain on domain events alongside pool/direction', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    const typed = moduleRef.get(TYPED_EVENT_BUS) as TypedEventBus;
    const memoryBus = moduleRef.get(EVENT_BUS) as MemoryEventBus;

    const received: DomainEvent[] = [];
    memoryBus.subscribe(EVENT_TYPE, async (e) => { received.push(e); });

    await typed.publish(EVENT_TYPE, 'c-1', PAYLOAD);

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata?.['tier']).toBe('domain');
    expect(received[0]?.metadata?.['pool']).toBe('events_change');
    expect(received[0]?.metadata?.['direction']).toBe('change');

    await moduleRef.close();
  });

  it('TypedEventBus.publish() stamps tier=audit and forces pool/direction null on audit events', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    const typed = moduleRef.get(TYPED_EVENT_BUS) as TypedEventBus;
    const memoryBus = moduleRef.get(EVENT_BUS) as MemoryEventBus;

    const AUDIT_TYPE = 'crm_sync_started' as const;
    const AUDIT_PAYLOAD = {
      runId: '11111111-1111-1111-1111-111111111111',
      source: 'salesforce',
    };

    const received: DomainEvent[] = [];
    memoryBus.subscribe(AUDIT_TYPE, async (e) => { received.push(e); });

    await typed.publish(AUDIT_TYPE, 'run-1', AUDIT_PAYLOAD);

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata?.['tier']).toBe('audit');
    expect(received[0]?.metadata?.['pool']).toBeNull();
    expect(received[0]?.metadata?.['direction']).toBeNull();

    await moduleRef.close();
  });

  it('TypedEventBus.publish() silently overrides caller-supplied pool/direction on audit events', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory' })],
    }).compile();

    const typed = moduleRef.get(TYPED_EVENT_BUS) as TypedEventBus;
    const memoryBus = moduleRef.get(EVENT_BUS) as MemoryEventBus;

    const AUDIT_TYPE = 'crm_sync_started' as const;
    const AUDIT_PAYLOAD = {
      runId: '11111111-1111-1111-1111-111111111111',
      source: 'salesforce',
    };

    const received: DomainEvent[] = [];
    memoryBus.subscribe(AUDIT_TYPE, async (e) => { received.push(e); });

    // Caller (incorrectly) tries to set pool/direction on an audit event.
    // The bus must silently override these to null. Per spec, this is a
    // documented contract — not an error — accompanied by a debug-level log.
    await typed.publish(AUDIT_TYPE, 'run-1', AUDIT_PAYLOAD, {
      metadata: { pool: 'events_change', direction: 'change', extra: 'kept' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata?.['tier']).toBe('audit');
    expect(received[0]?.metadata?.['pool']).toBeNull();
    expect(received[0]?.metadata?.['direction']).toBeNull();
    // Other caller-supplied metadata fields are preserved.
    expect(received[0]?.metadata?.['extra']).toBe('kept');

    await moduleRef.close();
  });

  it('TypedEventBus.publish() succeeds and preserves tenantId when multiTenant: true and tenantId is supplied', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule.forRoot({ backend: 'memory', multiTenant: true })],
    }).compile();

    const typed = moduleRef.get(TYPED_EVENT_BUS) as TypedEventBus;
    const memoryBus = moduleRef.get(EVENT_BUS) as MemoryEventBus;

    const received: DomainEvent[] = [];
    memoryBus.subscribe(EVENT_TYPE, async (e) => { received.push(e); });

    await typed.publish(EVENT_TYPE, 'c-1', PAYLOAD, {
      metadata: { tenantId: 't1' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata?.['tenantId']).toBe('t1');
    // Registry-stamped fields are still there alongside the tenantId.
    expect(received[0]?.metadata?.['pool']).toBe('events_change');
    expect(received[0]?.metadata?.['direction']).toBe('change');

    await moduleRef.close();
  });
});

describe('EventsModule.forRoot({ backend: "drizzle" })', () => {
  it('exposes TYPED_EVENT_BUS and EVENTS_MULTI_TENANT alongside EVENT_BUS', () => {
    // Construct the DynamicModule without compiling it (Drizzle backend
    // would require a DrizzleClient provider). We just assert the
    // providers array and the exports list.
    const dyn = EventsModule.forRoot({ backend: 'drizzle', multiTenant: true });
    expect(dyn.global).toBe(true);
    expect(dyn.exports).toContain(EVENT_BUS);
    expect(dyn.exports).toContain(TYPED_EVENT_BUS);
    expect(dyn.exports).toContain(EVENTS_MULTI_TENANT);

    const hasProvide = (token: unknown) =>
      dyn.providers?.some(
        (p) =>
          typeof p === 'object' && p !== null && 'provide' in p && p.provide === token,
      );
    expect(hasProvide(TYPED_EVENT_BUS)).toBe(true);
    expect(hasProvide(EVENTS_MULTI_TENANT)).toBe(true);
  });
});

describe('EventsModule.forRoot({ backend: "redis" })', () => {
  it('exposes TYPED_EVENT_BUS and EVENTS_MULTI_TENANT alongside EVENT_BUS', () => {
    const dyn = EventsModule.forRoot({
      backend: 'redis',
      redisUrl: 'redis://localhost:6379',
      multiTenant: true,
    });
    expect(dyn.global).toBe(true);
    expect(dyn.exports).toContain(EVENT_BUS);
    expect(dyn.exports).toContain(TYPED_EVENT_BUS);
    expect(dyn.exports).toContain(EVENTS_MULTI_TENANT);
  });
});

describe('EventsModule.forRootAsync', () => {
  it('wires EVENT_BUS, TYPED_EVENT_BUS, and EVENTS_MULTI_TENANT from an async factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventsModule.forRootAsync({
          useFactory: () => ({ backend: 'memory', multiTenant: true }),
        }),
      ],
    }).compile();

    const bus = moduleRef.get(EVENT_BUS);
    const typed = moduleRef.get(TYPED_EVENT_BUS);
    const multiTenant = moduleRef.get(EVENTS_MULTI_TENANT);

    expect(bus).toBeInstanceOf(MemoryEventBus);
    expect(typed).toBeInstanceOf(TypedEventBus);
    expect(multiTenant).toBe(true);

    // Behaviour matches forRoot: missing tenantId throws.
    await expect(
      (typed as TypedEventBus).publish(EVENT_TYPE, 'c-1', PAYLOAD),
    ).rejects.toBeInstanceOf(MissingTenantIdError);

    await moduleRef.close();
  });
});

// ============================================================================
// Regression — issue #108 — forRootAsync must resolve backend constructor
// args through Nest DI, not hand-construct with zero args.
// ============================================================================

import { mock } from 'bun:test';
import { Global } from '@nestjs/common';
import { DrizzleEventBus } from '../../../../runtime/subsystems/events/event-bus.drizzle-backend';
import { DRIZZLE } from '../../../../runtime/constants/tokens';

describe('EventsModule.forRootAsync — DI for backend constructor args (#108)', () => {
  /**
   * Minimal Drizzle-shaped mock — captures insert().values(...) so the test
   * can assert publish() actually reached the injected client rather than an
   * undefined/bare-constructed one.
   */
  function makeMockDb() {
    const insertBuilder = {
      values: mock(async (_args: unknown) => []),
    };
    const db = {
      insert: mock(() => insertBuilder),
    };
    return { db, insertBuilder };
  }

  it('resolves DRIZZLE through DI for the drizzle backend (regression: used to bare-construct with undefined db)', async () => {
    const { db, insertBuilder } = makeMockDb();

    // Real consumers expose DRIZZLE via a @Global() DatabaseModule. Mirror
    // that here so EventsModule.forRootAsync can see the token.
    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: db }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        EventsModule.forRootAsync({
          useFactory: () => ({ backend: 'drizzle' }),
        }),
      ],
    }).compile();

    const bus = moduleRef.get(EVENT_BUS);
    expect(bus).toBeInstanceOf(DrizzleEventBus);

    // Prove publish reached the injected mock DB. Pre-fix the backend was
    // constructed via `new DrizzleEventBus()` with zero args, leaving `db`
    // undefined — this call would throw "Cannot read properties of undefined
    // (reading 'insert')" on the hand-constructed instance.
    await (bus as DrizzleEventBus).publish({
      id: 'id-1',
      type: 'contact_created',
      aggregateId: 'a-1',
      aggregateType: 'contact',
      payload: {},
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      metadata: { pool: 'events_change', direction: 'change' },
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertBuilder.values).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  it('throws a clear error when the drizzle backend is selected but DRIZZLE is not provided', async () => {
    // No DRIZZLE provider in the module — the factory should surface a
    // descriptive error rather than silently constructing a broken bus.
    await expect(
      Test.createTestingModule({
        imports: [
          EventsModule.forRootAsync({
            useFactory: () => ({ backend: 'drizzle' }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/DRIZZLE provider is not available/);
  });

  it('redis backend receives the resolved REDIS_URL via DI (no bare construction)', async () => {
    // We don't want to actually connect to Redis; assert the instance was
    // constructed with the expected injected URL. Constructor alone does
    // not open a connection — that happens in onModuleInit, which
    // compile() does not invoke.
    const { RedisEventBus } = await import(
      '../../../../runtime/subsystems/events/event-bus.redis-backend'
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        EventsModule.forRootAsync({
          useFactory: () => ({
            backend: 'redis',
            redisUrl: 'redis://test-host:6379/0',
          }),
        }),
      ],
    }).compile();

    const bus = moduleRef.get(EVENT_BUS);
    expect(bus).toBeInstanceOf(RedisEventBus);
    // The constructor stores the URL on a private field; cast to access
    // for the assertion. The important property is that the URL arrived —
    // pre-fix it would have been `undefined`.
    expect((bus as unknown as { redisUrl: string }).redisUrl).toBe(
      'redis://test-host:6379/0',
    );

    await moduleRef.close();
  });
});
