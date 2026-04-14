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
