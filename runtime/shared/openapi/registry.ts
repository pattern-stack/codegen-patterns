/**
 * OpenApiRegistry — collects Zod schemas and path specs, emits a
 * complete `OpenAPIObject` on `build()` (OPENAPI-1).
 *
 * Each registered schema becomes a component through Zod 4's own
 * `z.toJSONSchema` (OpenAPI 3.0 target, the schema's input side — what a
 * client sends). No peer dependency (ZOD-1; it was `@anatine/zod-openapi`,
 * which reads only Zod 3).
 *
 * The registry is the single source of truth consumed by OPENAPI-2
 * (generated DTOs register their Zod schemas at module init), OPENAPI-3
 * (controller decorators reference those schemas), and OPENAPI-4
 * (Swagger UI bootstrap calls `build()` once at startup).
 */
import { z } from 'zod';

import { ERROR_RESPONSE_SCHEMA_NAME, errorResponseSchema } from './error-response.dto';
import { DuplicateSchemaError } from './errors';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete' | 'put';

/**
 * OpenAPI path spec. Structurally compatible with `openapi3-ts`'s
 * `OperationObject` but typed loosely here because the peer type package
 * isn't installed as a direct dep — consumers supply whatever their
 * codegen emits.
 */
export interface PathSpec {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: unknown[];
  [key: string]: unknown;
}

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

/** Minimal OpenAPIObject shape: the document assembly is ours. */
export interface OpenAPIObject {
  openapi: string;
  info: OpenAPIInfo;
  paths: Record<string, Record<string, PathSpec>>;
  components: {
    schemas: Record<string, unknown>;
  };
}

/**
 * One component's schema. A JSON value: a date has no JSON form, so it is
 * written as the string a client sends (`format: date-time`), and the
 * per-document `$schema` key is dropped.
 */
function componentSchema(schema: z.ZodType): unknown {
  const { $schema: _dialect, ...component } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === 'date') {
        Object.assign(jsonSchema, { type: 'string', format: 'date-time' });
      }
    },
  }) as Record<string, unknown>;
  return component;
}

export class OpenApiRegistry {
  private zodSchemas = new Map<string, z.ZodType>();
  private pathEntries = new Map<string, Map<HttpMethod, PathSpec>>();

  constructor() {
    // Auto-register the shared error response schema so controllers that
    // reference `#/components/schemas/ErrorResponseDto` always resolve
    // (OPENAPI-3). Consumers can `reset()` + re-register in tests.
    this.zodSchemas.set(ERROR_RESPONSE_SCHEMA_NAME, errorResponseSchema);
  }

  registerSchema(name: string, schema: z.ZodType): void {
    if (this.zodSchemas.has(name)) {
      throw new DuplicateSchemaError(name);
    }
    this.zodSchemas.set(name, schema);
  }

  registerPath(path: string, method: HttpMethod, spec: PathSpec): void {
    let methods = this.pathEntries.get(path);
    if (!methods) {
      methods = new Map();
      this.pathEntries.set(path, methods);
    }
    methods.set(method, spec);
  }

  /**
   * Emit the full OpenAPI document.
   *
   * OpenAPI version is pinned to `3.0.3` — Swagger UI tooling is most
   * stable on 3.0.x (see OPENAPI-PHASE-1-PLAN §Four locked decisions).
   */
  async build(info: OpenAPIInfo): Promise<OpenAPIObject> {
    const schemas: Record<string, unknown> = {};
    for (const [name, zodSchema] of this.zodSchemas) {
      schemas[name] = componentSchema(zodSchema);
    }

    const paths: Record<string, Record<string, PathSpec>> = {};
    for (const [path, methods] of this.pathEntries) {
      const methodMap: Record<string, PathSpec> = {};
      for (const [method, spec] of methods) {
        methodMap[method] = spec;
      }
      paths[path] = methodMap;
    }

    return {
      openapi: '3.0.3',
      info,
      paths,
      components: { schemas },
    };
  }

  /**
   * Test helper — clears registered schemas and paths, then re-seeds the
   * core `ErrorResponseDto` entry so post-reset state matches the
   * invariant established in the constructor.
   */
  reset(): void {
    this.zodSchemas.clear();
    this.pathEntries.clear();
    this.zodSchemas.set(ERROR_RESPONSE_SCHEMA_NAME, errorResponseSchema);
  }
}
