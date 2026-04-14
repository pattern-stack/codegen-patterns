/**
 * Injection tokens for the analytics subsystem.
 *
 * String constants (not Symbols) so they match by value across import
 * boundaries — same convention as events.tokens.ts.
 *
 * Usage in services:
 * ```typescript
 * constructor(@Inject(ANALYTICS_QUERY) private readonly analytics: IAnalyticsQuery) {}
 * ```
 */
export const ANALYTICS_QUERY = 'ANALYTICS_QUERY' as const;

/**
 * Injection token for the cube.js API URL.
 * Provided automatically by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
export const CUBE_API_URL = Symbol('CUBE_API_URL');

/**
 * Injection token for the cube.js API secret.
 * Provided automatically by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
export const CUBE_API_SECRET = Symbol('CUBE_API_SECRET');
