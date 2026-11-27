/**
 * Typed errors for the OpenAPI registry (OPENAPI-1).
 *
 * Same shape as `runtime/subsystems/bridge/bridge-errors.ts` so consumers
 * can catch them with the same exception-filter pattern used elsewhere.
 */

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
