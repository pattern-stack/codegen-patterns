/**
 * OpenAPI shared subsystem — public API (OPENAPI-1).
 *
 * Consumed by generated DTO providers (OPENAPI-2), controller decorators
 * (OPENAPI-3), and the Swagger UI bootstrap (OPENAPI-4).
 */
export { OpenApiRegistry } from './registry';
export type {
  HttpMethod,
  PathSpec,
  OpenAPIInfo,
  OpenAPIObject,
} from './registry';
export { OPENAPI_REGISTRY } from './registry.tokens';
export { OpenApiPeerDepMissingError, DuplicateSchemaError } from './errors';
export {
  ERROR_RESPONSE_SCHEMA_NAME,
  errorResponseSchema,
} from './error-response.dto';
export type { ErrorResponseDto } from './error-response.dto';
