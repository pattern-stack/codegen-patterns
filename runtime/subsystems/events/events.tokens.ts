/**
 * Injection token for the event bus.
 *
 * String constant (not Symbol) so it matches by value across import boundaries.
 * Matches the token in runtime/constants/tokens.ts — both are 'EVENT_BUS'.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}
 * ```
 */
import { tokenKey } from '../token-key';

export const EVENT_BUS = 'EVENT_BUS' as const;

/**
 * Injection token for the read-side `IEventReadPort` over `domain_events`
 * (OBS-LIST-1).
 *
 * Bound by `EventsModule.forRoot` to the same backend instance as
 * `EVENT_BUS` for ALL backends — `drizzle`, `memory`, and `bullmq` (the
 * bullmq backend extends `DrizzleEventBus`, so it inherits `IEventReadPort`
 * over the same `domain_events` outbox; ADR-041). Consumers composing it
 * (e.g. the observability combiner) may still inject it `@Optional()`.
 *
 * String constant (not Symbol) so it matches by value across import
 * boundaries — same convention as `EVENT_BUS`.
 */
export const EVENT_READ_PORT = 'EVENT_READ_PORT' as const;

/**
 * Injection token for the generated `TypedEventBus` facade.
 *
 * `TypedEventBus` lives in `runtime/subsystems/events/generated/bus.ts` and
 * wraps `IEventBus` with project-specific `AppDomainEvent`-typed `publish<T>()`
 * and `subscribe<T>()`. Use cases inject this token in preference to
 * `EVENT_BUS` when they want compile-time type safety on event shapes.
 *
 * String constant (not Symbol) so it matches by value across import
 * boundaries — same convention as `EVENT_BUS`.
 *
 * Provider registration lands in EVT-6 (EventsModule wiring); the token is
 * declared here so generated code can import it without depending on the
 * still-being-formalised module.
 */
export const TYPED_EVENT_BUS = 'TYPED_EVENT_BUS' as const;

/**
 * Injection token for the resolved multi-tenancy flag.
 *
 * Provided by `EventsModule.forRoot(...)` as `options.multiTenant ?? false`.
 * Consumed by `TypedEventBus` to enforce the tenantId-is-required rule at
 * publish time.
 *
 * String constant (not Symbol) so it matches by value across import
 * boundaries — same convention as the other events tokens. (The jobs
 * subsystem uses Symbols for the analogous token; events chose strings
 * from the start and we keep the file internally consistent.)
 */
export const EVENTS_MULTI_TENANT = 'EVENTS_MULTI_TENANT' as const;

/**
 * Injection token for the resolved BullMQ/ioredis `ConnectionOptions` used by
 * `BullMQEventBus` (ADR-041). Provided automatically by
 * `EventsModule.forRoot({ backend: 'bullmq' })` as `{ url }`, resolved from
 * `options.redisUrl` → `process.env.REDIS_URL` → `redis://localhost:6379`.
 *
 * Shares the same `REDIS_URL` env default as the jobs subsystem's
 * `BULLMQ_CONNECTION`, so jobs + events compose on one Redis out of the box
 * (ADR-041 §"compose on one Redis").
 *
 * ADR-037: namespaced `Symbol.for(...)` (via `tokenKey()`) so it matches by
 * value across runtime copies.
 */
export const EVENTS_BULLMQ_CONNECTION = Symbol.for(
  tokenKey('events', 'bullmq-connection'),
);

/**
 * Injection token for the resolved `EventsModuleOptions` object.
 *
 * Provided automatically by `EventsModule.forRoot(...)` /
 * `EventsModule.forRootAsync(...)`. Backends that need to observe module
 * configuration (e.g. `DrizzleEventBus` reading `opts.pools` for
 * pool-filtered drain) inject via this token.
 *
 * String-valued (not `Symbol`) so it matches by value across import
 * boundaries — same convention as `EVENT_BUS`.
 */
export const EVENTS_MODULE_OPTIONS = 'EVENTS_MODULE_OPTIONS' as const;
