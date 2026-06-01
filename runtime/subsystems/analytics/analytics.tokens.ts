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
import { tokenKey } from '../token-key';

export const ANALYTICS_QUERY = 'ANALYTICS_QUERY' as const;

// ADR-037: namespaced `Symbol.for(...)` keys (via `tokenKey()`) so these tokens
// match by value across import boundaries (package vs vendored runtime copy).
/**
 * Injection token for the cube.js API URL.
 * Provided automatically by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
export const CUBE_API_URL = Symbol.for(tokenKey('analytics', 'cube-api-url'));

/**
 * Injection token for the cube.js API secret.
 * Provided automatically by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
export const CUBE_API_SECRET = Symbol.for(tokenKey('analytics', 'cube-api-secret'));
