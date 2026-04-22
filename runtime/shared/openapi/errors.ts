/**
 * Typed errors for the OpenAPI registry (OPENAPI-1).
 *
 * Same shape as `runtime/subsystems/bridge/bridge-errors.ts` so consumers
 * can catch them with the same exception-filter pattern used elsewhere.
 */

/**
 * Thrown by `OpenApiRegistry.build()` when `@anatine/zod-openapi` is not
 * resolvable. The peer is declared optional (`peerDependenciesMeta`) so
 * consumer apps that don't care about OpenAPI still boot; the cost is a
 * deferred failure here on first `build()`.
 */
export class OpenApiPeerDepMissingError extends Error {
  override readonly name = 'OpenApiPeerDepMissingError';
  constructor(message?: string) {
    super(
      message ??
        'OpenApiRegistry requires @anatine/zod-openapi. Install it: bun add @anatine/zod-openapi',
    );
  }
}

/**
 * Thrown by `OpenApiRegistry.registerSchema(name, ...)` when `name` is
 * already registered. Silent overwrite would make debugging
 * double-registration bugs (e.g. two entity pipelines both emitting a
 * `User` DTO) painful; loud failure lets the mismatch surface at module
 * init where the stack trace is clear.
 */
export class DuplicateSchemaError extends Error {
  override readonly name = 'DuplicateSchemaError';
  constructor(public readonly schemaName: string) {
    super(
      `DuplicateSchemaError: schema '${schemaName}' is already registered. ` +
        `Each schema name must be unique within the OpenApiRegistry.`,
    );
  }
}
