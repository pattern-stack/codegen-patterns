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

// ADR-037: namespaced `Symbol.for(...)` keys so these tokens match by value
// across import boundaries (package vs vendored runtime copy).
// TODO(token-version): revisit embedding a contract version once codegen/surface
// versioning is settled.
/**
 * Injection token for the cube.js API URL.
 * Provided automatically by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
export const CUBE_API_URL = Symbol.for('@pattern-stack/codegen.analytics.cube-api-url');

/**
 * Injection token for the cube.js API secret.
 * Provided automatically by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
export const CUBE_API_SECRET = Symbol.for('@pattern-stack/codegen.analytics.cube-api-secret');
