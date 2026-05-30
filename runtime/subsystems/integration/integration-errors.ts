/**
 * Typed errors + shared boundary helpers for the integration subsystem.
 *
 * Classes (not bare Error) so consumers can `instanceof` them in catch
 * blocks and exception filters can map them to HTTP codes.
 *
 * Mirrors the shape of `events-errors.ts` and `jobs-errors.ts`.
 */

/**
 * Thrown by the Drizzle cursor-store / run-recorder backends AND by the
 * orchestrator entry point when `INTEGRATION_MULTI_TENANT` is enabled but the
 * caller did not supply a non-null `tenantId`. Strict enforcement at the
 * boundary — explicit `null` still throws.
 *
 * Disable multi-tenancy on the module (`multiTenant: false`, the default)
 * to opt out of the requirement entirely.
 *
 * `operation` identifies the call site (e.g. `'cursor.put'`,
 * `'startRun'`, `'execute'`) so the stack-trace message points at the
 * specific boundary that rejected the input.
 */
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';
  constructor(operation: string) {
    super(
      `Missing tenantId for integration operation '${operation}'. IntegrationModule is ` +
        `configured with multiTenant: true — every call must include a ` +
        `non-null tenantId. Either pass the tenantId or disable multi-` +
        `tenancy on the module.`,
    );
  }
}

/**
 * Shared boundary guard — used at the orchestrator entry AND inside the
 * Drizzle backends. Keeping the check in one function guarantees every
 * `MissingTenantIdError` carries the same message shape regardless of the
 * site that raised it, which makes it easier for consumers to pattern-
 * match on the error in logs/metrics.
 *
 * When `multiTenant` is false, the function is a no-op — `tenantId` may
 * be anything (including `undefined`). When true, `undefined` or `null`
 * throws.
 */
export function assertTenantId(
  tenantId: string | null | undefined,
  options: { multiTenant: boolean; operation: string },
): asserts tenantId is string {
  if (!options.multiTenant) return;
  if (tenantId === undefined || tenantId === null) {
    throw new MissingTenantIdError(options.operation);
  }
}
