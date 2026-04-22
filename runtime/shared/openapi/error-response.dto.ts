/**
 * Shared error response schema (OPENAPI-3).
 *
 * Generated controllers `@ApiResponse(...)` decorators reference this
 * schema by `$ref` (name `ErrorResponseDto`) for non-success status codes
 * (400, 401, 404, etc.). Shape matches NestJS's default `HttpException`
 * JSON body — see `packages/common/src/exceptions/http.exception.ts`.
 *
 * The registry auto-registers this schema on construction so every
 * consumer project exposes `components.schemas.ErrorResponseDto` on
 * `/docs-json` without per-entity duplication.
 */
import { z } from 'zod';

export const errorResponseSchema = z.object({
  statusCode: z.number().int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
});

export type ErrorResponseDto = z.infer<typeof errorResponseSchema>;

/** Canonical name used across `$ref` URIs in generated controllers. */
export const ERROR_RESPONSE_SCHEMA_NAME = 'ErrorResponseDto';
