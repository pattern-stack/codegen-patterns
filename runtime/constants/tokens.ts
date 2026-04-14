/**
 * NestJS injection tokens
 *
 * Used with @Inject() decorator in concrete repository constructors.
 */

/**
 * Injection token for the Drizzle ORM database client.
 *
 * Usage in concrete repositories:
 * ```typescript
 * constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
 * ```
 */
export const DRIZZLE = 'DRIZZLE' as const;

/**
 * Injection token for the event bus (IEventBus).
 *
 * Optional — only resolved when EventsModule.forRoot() is registered.
 * BaseService uses this with @Optional() to emit lifecycle events
 * without requiring the events subsystem to be installed.
 *
 * Usage in services/use cases:
 * ```typescript
 * @Optional() @Inject(EVENT_BUS) eventBus?: IEventBus
 * ```
 */
export const EVENT_BUS = 'EVENT_BUS' as const;
