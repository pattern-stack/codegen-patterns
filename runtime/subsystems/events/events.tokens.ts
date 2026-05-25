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
export const EVENT_BUS = 'EVENT_BUS' as const;

/**
 * Injection token for the read-side `IEventReadPort` over `domain_events`
 * (OBS-LIST-1).
 *
 * Bound by `EventsModule.forRoot` to the same backend instance as
 * `EVENT_BUS` for the `drizzle` and `memory` backends (both implement
 * `IEventReadPort`). The `redis` backend retains no history and therefore
 * does NOT provide this token — consumers composing it (e.g. the
 * observability combiner) inject it `@Optional()` and degrade to empty
 * results.
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
 * Injection token for the Redis connection URL used by RedisEventBus.
 * Provided automatically by EventsModule.forRoot({ backend: 'redis' }).
 */
export const REDIS_URL = Symbol('REDIS_URL');

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
