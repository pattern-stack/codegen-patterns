# Protocol & Backends

The events subsystem follows the **Protocol → Backend → Factory** pattern (ADR-008). This file describes the `IEventBus` port, the concrete backends (Drizzle outbox, Memory, Redis), the `EventsModule.forRoot({ backend })` wiring, and the steps to add a new backend while respecting the core/extension principle (CLAUDE.md).

## Protocol — `IEventBus`

Source: `runtime/subsystems/events/event-bus.protocol.ts`. Three methods, no typed generics at the port:

```ts
export interface IEventBus {
  publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void>;
  publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void>;
  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void;
}
```

`DomainEvent`:

```ts
export interface DomainEvent {
  readonly id: string;               // UUID
  readonly type: string;             // discriminator
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly metadata?: Record<string, unknown>;
}
```

**Design choice: keep the port narrow.** Typed generics live on the `TypedEventBus` facade (see `event-codegen.md`), not on `IEventBus`. Rationale:
- The port is the hexagonal boundary — it should not depend on the generated registry (circular coupling).
- Backends should not have to know anything about app-declared event types.
- Typing is a consumer concern, handled one layer up.

**Protocol changes land rarely and require an ADR.** Current plan (Phase A): `metadata` gains well-known keys `pool` and `direction`, and the Drizzle backend adds `pool` / `direction` columns to the outbox table. No protocol method signatures change.

## Injection token

`runtime/subsystems/events/events.tokens.ts` exports:

```ts
export const EVENT_BUS = Symbol('EVENT_BUS');
```

Application code injects `@Inject(EVENT_BUS) private readonly bus: IEventBus`. Once the typed facade generator lands, app code injects `TypedEventBus` directly — the facade internally injects `EVENT_BUS`.

## Backends

### Drizzle backend (default, production)

`runtime/subsystems/events/event-bus.drizzle-backend.ts`. Postgres-backed with the transactional outbox pattern. Key properties:

- **`publish(event, tx?)`** — inserts one row into `domain_events`. Uses `tx` if provided, else the top-level `DrizzleClient`. Never fails silently; throws if the DB is unreachable.
- **`subscribe(type, handler)`** — registers in an in-memory `Map<string, Set<handler>>`. **Per-process subscription**: subscribers registered in process A do not receive events drained in process B. For multi-process setups, each process runs its own subscribers.
- **Polling loop** — `OnModuleInit` starts a 1s-interval poll. Each cycle: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50`, dispatch to handlers, update status. `OnModuleDestroy` stops the loop cleanly.
- **Retry policy** — up to 3 attempts per event; on persistent failure, row is marked `status='failed'` with the error message. No automatic retry after.

Strengths: zero new infra beyond Postgres; transactional guarantee; survives process crashes. Weaknesses: ~1000 events/s ceiling; polling latency floor of 1s; not real-time.

**Extensions (Drizzle-specific, opt-in):**
- `LISTEN/NOTIFY` for sub-second drain wakeups — opt-in, not portable to other backends.
- Advisory locks to protect hot-row hotspots — Postgres-only.
- The `pool` / `direction` columns are a Drizzle-backend optimization for the drain query; semantically the same information lives in `metadata`.

### Memory backend (tests)

`runtime/subsystems/events/event-bus.memory-backend.ts`. Synchronous, in-process.

- **`publish(event)`** — pushes into a `publishedEvents[]` array, dispatches to handlers immediately. **Ignores `tx`** — there is no transactional semantic in memory.
- **`publishMany(events)`** — calls `publish` in a loop.
- **`subscribe(type, handler)`** — same Map-based registry as Drizzle.
- **`clear()`** — test helper; drops all published events and handlers. Call in `beforeEach`.
- **`publishedEvents`** — public array for test assertions (`expect(bus.publishedEvents).toContainEqual({...})`).

Use in every test that touches the events subsystem. Swap via `EventsModule.forRoot({ backend: 'memory' })`.

**Key test property:** dispatch is synchronous. `await bus.publish(event)` returns only after all subscribers have handled the event. Tests do not need `waitFor` / timers. This is different from Drizzle, where dispatch is async via the polling loop.

### Redis backend

`runtime/subsystems/events/event-bus.redis-backend.ts`. Present but not the default. Intended for higher-throughput / real-time fan-out. Selected via `EventsModule.forRoot({ backend: 'redis', redisUrl: '...' })`.

Falls back to `REDIS_URL` env var or `redis://localhost:6379`. Note: the Redis backend does not participate in the Drizzle transaction — using `tx` with this backend is a silent no-op. Teams using Redis lose the transactional-outbox guarantee unless they layer their own outbox-table-then-publish dual-write pattern. This is called out here because it is easy to miss.

## Factory — `EventsModule.forRoot`

`runtime/subsystems/events/events.module.ts`:

```ts
@Module({})
export class EventsModule {
  static forRoot(options: EventsModuleOptions = { backend: 'drizzle' }): DynamicModule {
    // ... returns DynamicModule with `global: true` ...
  }
  static forRootAsync(asyncOptions: EventsModuleAsyncOptions): DynamicModule { /* ... */ }
}
```

Registered once in `AppModule`:

```ts
@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    // other subsystems
  ],
})
export class AppModule {}
```

`global: true` means entity modules don't need to import `EventsModule` individually — the `EVENT_BUS` token is available project-wide. Tests swap:

```ts
Test.createTestingModule({
  imports: [EventsModule.forRoot({ backend: 'memory' })],
});
```

## Adding a new backend

Follow the core/extension principle from CLAUDE.md. The new class MUST implement every `IEventBus` method. It MAY expose additional methods, but consumers who use those methods lose portability.

Steps:
1. Create `event-bus.<name>-backend.ts` in `runtime/subsystems/events/`. Implement `IEventBus`. Decide whether `publish(event, tx?)` is transactional-outbox-capable; if not, document the gap clearly in the file header.
2. Add the backend name to the `EventsModuleOptions['backend']` union in `events.module.ts`.
3. Extend the `forRoot` switch to wire the new provider.
4. Add unit tests under `runtime/subsystems/events/__tests__/` that exercise `publish / publishMany / subscribe` against the new backend.
5. If the backend has extensions (native pub/sub, admin UI hooks, rate limiting), expose them as additional public methods on the class — do not smuggle them into `IEventBus`. Document the extensions in the file header so consumers know they are opting into backend-specific code.
6. If the backend adds schema (e.g. Redis stream names, Kafka topics), keep that config in a sibling `<name>-backend-config.ts` file; do not add options to `EventsModuleOptions` that only apply to some backends without a discriminated union.

**What not to do:**
- Do not widen `IEventBus` to accommodate backend-specific features. If a feature can only be implemented on one backend, it belongs on the backend class's public surface, not on the port.
- Do not flatten backend differences by pretending all backends support transactional semantics. A Redis backend does not; saying it does is a lie that will break production.
- Do not add a new backend that claims "transactional outbox" without a concrete transactional write path (or a documented dual-write-with-outbox-table pattern).

## Error handling

Per ADR-008:
- **`publish` failures propagate.** If the DB is unreachable, `publish` throws and the caller's transaction rolls back. There is no retry at this layer — retry is on the drain loop, after the transaction has committed successfully.
- **Handler failures are caught per-handler.** `DrizzleEventBus.dispatch` runs each handler inside try/catch, logs, and re-throws the first error after the batch. On throw, the outer loop counts it as an attempt; 3 attempts → `status='failed'`.
- **Memory backend treats handler failures differently** — it rethrows synchronously, so test assertions surface the failure immediately.

## Do not

- Do not add methods to `IEventBus` without an ADR.
- Do not inject `DrizzleEventBus` directly in application code. Inject via `EVENT_BUS` or `TypedEventBus`. Direct injection breaks the port.
- Do not bypass the factory to instantiate backends manually — `new DrizzleEventBus()` won't wire NestJS lifecycle hooks; the polling loop won't start.
- Do not use the Redis backend and expect outbox semantics. Use Drizzle for transactional publishes; reach for Redis only after measuring an actual bottleneck.

## See also

- `outbox-and-transactions.md` — the Drizzle backend's outbox semantics in detail
- `event-codegen.md` — the `TypedEventBus` facade that wraps `IEventBus`
- `directions-and-pools.md` — Phase A changes to the Drizzle backend (pool/direction columns)
- `docs/adrs/ADR-008-subsystem-architecture.md` — Protocol → Backend → Factory pattern
- `CLAUDE.md` — core/extension principle
