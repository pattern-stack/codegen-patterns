/**
 * Injection token for the event bus.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}
 * ```
 */
export const EVENT_BUS = Symbol('EVENT_BUS');
