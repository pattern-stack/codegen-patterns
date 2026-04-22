/**
 * OpenApiRegistry — collects Zod schemas and path specs, emits a
 * complete `OpenAPIObject` on `build()` (OPENAPI-1).
 *
 * Wraps `@anatine/zod-openapi` as an **optional peer dependency** using
 * the lazy-import pattern from `runtime/subsystems/analytics/cube-backend.ts`
 * — consumer apps that never call `build()` still boot even if
 * `@anatine/zod-openapi` isn't installed.
 *
 * The registry is the single source of truth consumed by OPENAPI-2
 * (generated DTOs register their Zod schemas at module init), OPENAPI-3
 * (controller decorators reference those schemas), and OPENAPI-4
 * (Swagger UI bootstrap calls `build()` once at startup).
 */
import type { z } from 'zod';

import { OpenApiPeerDepMissingError, DuplicateSchemaError } from './errors';

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

/**
 * Minimal OpenAPIObject shape. We redeclare rather than pull
 * `openapi3-ts` types through the peer — the peer's `generateSchema`
 * returns a `SchemaObject`, but the final document assembly is ours.
 */
export interface OpenAPIObject {
  openapi: string;
  info: OpenAPIInfo;
  paths: Record<string, Record<string, PathSpec>>;
  components: {
    schemas: Record<string, unknown>;
  };
}

interface PeerModule {
  generateSchema: (zodRef: unknown, useOutput?: boolean, version?: '3.0' | '3.1') => unknown;
}

export class OpenApiRegistry {
  private zodSchemas = new Map<string, z.ZodType>();
  private pathEntries = new Map<string, Map<HttpMethod, PathSpec>>();
  private peer: PeerModule | null = null;

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
   * Emit the full OpenAPI document. Lazy-imports `@anatine/zod-openapi`
   * on first call; failure to resolve raises `OpenApiPeerDepMissingError`
   * (matches the `CubeAnalyticsBackend.onModuleInit` precedent).
   *
   * OpenAPI version is pinned to `3.0.3` — Swagger UI tooling is most
   * stable on 3.0.x (see OPENAPI-PHASE-1-PLAN §Four locked decisions).
   */
  async build(info: OpenAPIInfo): Promise<OpenAPIObject> {
    const peer = await this.loadPeer();

    const schemas: Record<string, unknown> = {};
    for (const [name, zodSchema] of this.zodSchemas) {
      schemas[name] = peer.generateSchema(zodSchema, false, '3.0');
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

  /** Test helper — clears all registered schemas and paths. */
  reset(): void {
    this.zodSchemas.clear();
    this.pathEntries.clear();
    this.peer = null;
  }

  protected async loadPeer(): Promise<PeerModule> {
    if (this.peer) return this.peer;
    try {
      // Re-resolved on each failure so consumers can install the peer
      // and retry without restarting the process.
      const mod = (await import('@anatine/zod-openapi')) as PeerModule;
      this.peer = mod;
      return mod;
    } catch {
      throw new OpenApiPeerDepMissingError();
    }
  }
}
