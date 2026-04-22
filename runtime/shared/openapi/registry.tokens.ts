/**
 * Injection token for the OpenAPI registry (OPENAPI-1).
 *
 * String constant (not a Symbol) so it matches by value across import
 * boundaries — same convention as `ANALYTICS_QUERY` in analytics and
 * `EVENT_BUS` / `BRIDGE_DELIVERY_REPO` in events / bridge. The OPENAPI-1
 * spec sketched a Symbol, but the repo-wide convention wins — codebase
 * consistency matters more than the spec's initial guess.
 *
 * Consumed by generated DTO providers (OPENAPI-2), controllers
 * (OPENAPI-3), and the Swagger bootstrap (OPENAPI-4).
 */
export const OPENAPI_REGISTRY = 'OPENAPI_REGISTRY' as const;
