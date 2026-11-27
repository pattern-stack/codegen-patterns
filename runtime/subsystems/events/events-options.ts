/**
 * The events subsystem's options (`EventsModule.forRoot`, and the `events` system under pattern-stack wiring). In
 * their own Nest-free file (S-1), so the backends and `core.ts` import them without loading `@nestjs/*`.
 */
import type { RegistrySchedule } from './event-scheduler';

export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis';
  /**
   * Redis connection URL used when `backend` is `'redis'`.
   * Falls back to the REDIS_URL environment variable, then
   * `redis://localhost:6379` if neither is set.
   */
  redisUrl?: string;
  /**
   * Restrict the drain loop to these pools. Each pool name matches the
   * `domain_events.pool` column (populated from `event.metadata.pool` at
   * publish time). Leave undefined to drain all pending rows.
   *
   * Typical lane split: one process per `events_inbound` /
   * `events_change` / `events_outbound` so a slow outbound handler
   * cannot stall change-event propagation (see ADR-022).
   */
  pools?: string[];
  /**
   * LISTEN-NOTIFY-1 — when `true` (drizzle backend only), the drainer holds a
   * dedicated listener connection and LISTENs on `codegen_events_wake`. Each
   * `publish`/`publishMany` emits an in-tx `pg_notify(codegen_events_wake,
   * <pool>)` so the drainer wakes the moment the publishing transaction commits,
   * instead of waiting for the next poll tick. Polling continues unchanged as
   * the fallback heartbeat; a lost notify degrades to poll latency, never to
   * lost work. Defaults to `false`.
   *
   * Ignored by the memory + redis backends (memory dispatches inline; redis has
   * its own fan-out). Requires a direct (non-transaction-pooler) connection —
   * see the events/jobs config block re: PgBouncer.
   */
  listenNotify?: boolean;
  /**
   * Multi-tenancy opt-in (EVT-6).
   *
   * When `true`, every `TypedEventBus.publish()` call must supply
   * `opts.metadata.tenantId` — otherwise it throws `MissingTenantIdError`.
   * The tenantId is preserved on `event.metadata` and, for the Drizzle
   * backend, written to `domain_events.tenant_id` (EVT-4).
   *
   * Drain-side tenant filtering is deferred — the tenant-context model
   * (per-process vs. per-request vs. async-local-storage) is still
   * unsettled; see ADR-024 §Multi-tenancy. Only the publish-side
   * requirement ships here.
   *
   * Defaults to `false`.
   */
  multiTenant?: boolean;
  /**
   * The generated `TypedEventBus` class to bind to `TYPED_EVENT_BUS`.
   *
   * **Package mode (ADR-037).** When the runtime is imported from
   * `@pattern-stack/codegen` (not vendored), the bundled `./generated/bus`
   * `TypedEventBus` is typed to an EMPTY event union and reads the bundled
   * empty `eventRegistry` — a consumer's `events/*.yaml` are scanned into
   * `src/generated/events/bus.ts` (typed to THEIR union, reading THEIR
   * registry), which the package can't import. The generated subsystem barrel
   * therefore threads that class in here:
   * `EventsModule.forRoot({ ..., typedBus: TypedEventBus })`. Nest constructs
   * it with this module's `EVENT_BUS` + `EVENTS_MULTI_TENANT` providers (the
   * generated class injects the same string-valued tokens, which match across
   * the package boundary).
   *
   * Omitted (vendored mode / tests) ⇒ falls back to the bundled
   * `./generated/bus`, which in a vendored tree IS the consumer's generated
   * file. Without this, a package-mode consumer's typed `publish<'…'>()` calls
   * resolve against the empty union and their events never get the right
   * `pool` / `direction` stamped.
   *
   * Only consulted by `forRoot` (the path the barrel emits); `forRootAsync`
   * keeps the bundled bus.
   */
  typedBus?: abstract new (...args: never[]) => unknown;
  /**
   * ADR-039 — the consumer's generated `eventRegistry`, threaded so the
   * `EventScheduler` can read the `schedule:` block + routing metadata of every
   * scheduled event. Package mode: the generated subsystem barrel passes the
   * consumer's `eventRegistry` (the bundled one is the package's empty/fixture
   * registry, which the package can't see the consumer's events through — same
   * reason `typedBus` is threaded). Omitted ⇒ no scheduler is spawned (vendored
   * tree reads its own bundled registry only if the barrel passes it; tests
   * pass a registry directly).
   *
   * Structural shape: each value needs `schedule?` + `direction` + `pool`. The
   * generated `EventMetadata` satisfies it; typing it loosely here avoids a
   * runtime dependency on the generated types from the module file.
   */
  eventRegistry?: Record<
    string,
    { schedule?: RegistrySchedule; direction: string | null; pool: string | null }
  >;
}
