/**
 * Injection token for the event bus.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}
 * ```
 */
export const EVENT_BUS = Symbol('EVENT_BUS');

/**
 * Injection token for the Redis connection URL used by RedisEventBus.
 * Provided automatically by EventsModule.forRoot({ backend: 'redis' }).
 */
export const REDIS_URL = Symbol('REDIS_URL');
