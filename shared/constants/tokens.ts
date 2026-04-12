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
