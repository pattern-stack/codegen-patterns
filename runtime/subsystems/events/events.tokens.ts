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
