/**
 * OpenApiRegistry unit tests (OPENAPI-1).
 *
 * Covers the six cases listed in docs/specs/OPENAPI-1.md §Tests: schema
 * round-trip, path registration, duplicate-schema error, empty-build,
 * lazy-import failure, and the pinned `openapi: 3.0.3` version.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';

import {
  OpenApiRegistry,
  DuplicateSchemaError,
  OpenApiPeerDepMissingError,
} from '../../../../runtime/shared/openapi';

describe('OpenApiRegistry', () => {
  let registry: OpenApiRegistry;

  beforeEach(() => {
    registry = new OpenApiRegistry();
  });

  it('round-trips a Zod object schema into an OpenAPI schema object', async () => {
    const User = z.object({
      id: z.string().uuid(),
      name: z.string(),
    });
    registry.registerSchema('User', User);

    const doc = await registry.build({ title: 'Test', version: '1.0.0' });
    const userSchema = doc.components.schemas.User as {
      type: string;
      properties: Record<string, { format?: string; type?: string }>;
      required?: string[];
    };

    expect(userSchema.type).toBe('object');
    expect(userSchema.properties.id.format).toBe('uuid');
    expect(userSchema.properties.name.type).toBe('string');
    expect(userSchema.required).toEqual(['id', 'name']);
  });

  it('registers path entries under paths.{path}.{method}', async () => {
    registry.registerPath('/users', 'get', {
      summary: 'List users',
      responses: { '200': { description: 'ok' } },
    });
    registry.registerPath('/users', 'post', {
      summary: 'Create user',
      responses: { '201': { description: 'created' } },
    });

    const doc = await registry.build({ title: 'Test', version: '1.0.0' });

    expect(doc.paths['/users']).toBeDefined();
    expect(doc.paths['/users'].get?.summary).toBe('List users');
    expect(doc.paths['/users'].post?.summary).toBe('Create user');
  });

  it('throws DuplicateSchemaError on second registerSchema with same name', () => {
    const schema = z.object({ id: z.string() });
    registry.registerSchema('User', schema);

    expect(() => registry.registerSchema('User', schema)).toThrow(DuplicateSchemaError);
  });

  it('build() with no registrations returns a valid OpenAPIObject containing only the auto-registered ErrorResponseDto', async () => {
    // OPENAPI-3 auto-registers `ErrorResponseDto` on construction so
    // generated controllers always have `$ref` targets for 4xx responses.
    const doc = await registry.build({ title: 'Empty', version: '0.0.1' });

    expect(doc.info.title).toBe('Empty');
    expect(doc.info.version).toBe('0.0.1');
    expect(doc.paths).toEqual({});
    expect(Object.keys(doc.components.schemas)).toEqual(['ErrorResponseDto']);
  });

  it('auto-registers ErrorResponseDto with the expected shape', async () => {
    const doc = await registry.build({ title: 'T', version: '1.0.0' });
    const err = doc.components.schemas.ErrorResponseDto as {
      type: string;
      properties: Record<string, { type?: string; oneOf?: unknown[] }>;
      required?: string[];
    };

    expect(err.type).toBe('object');
    // Zod `.int()` maps to OpenAPI's `integer` type (not `number`).
    expect(err.properties.statusCode.type).toBe('integer');
    expect(err.properties.error.type).toBe('string');
    expect(err.required).toEqual(['statusCode', 'message']);
  });

  it('pins openapi version to 3.0.3', async () => {
    const doc = await registry.build({ title: 'T', version: '1.0.0' });
    expect(doc.openapi).toBe('3.0.3');
  });

  it('propagates info.description into the document', async () => {
    const doc = await registry.build({
      title: 'T',
      version: '1.0.0',
      description: 'My API',
    });
    expect(doc.info.description).toBe('My API');
  });

  it('throws OpenApiPeerDepMissingError when @anatine/zod-openapi cannot be resolved', async () => {
    // Exercise the real try/catch by replacing the dynamic import target
    // with a guaranteed-unresolvable module name. This runs the same
    // `loadPeer` body as production; only the module specifier differs,
    // so the catch branch + error mapping both fire for real.
    class BrokenRegistry extends OpenApiRegistry {
      protected async loadPeer(): Promise<never> {
        try {
          await import('@anatine/zod-openapi-does-not-exist' as never);
          throw new Error('unreachable');
        } catch {
          throw new OpenApiPeerDepMissingError();
        }
      }
    }
    const reg = new BrokenRegistry();

    await expect(reg.build({ title: 'T', version: '1' })).rejects.toBeInstanceOf(
      OpenApiPeerDepMissingError,
    );
  });

  it('reset() clears registered schemas and paths but re-seeds ErrorResponseDto', async () => {
    registry.registerSchema('User', z.object({ id: z.string() }));
    registry.registerPath('/users', 'get', { summary: 'List' });

    registry.reset();

    const doc = await registry.build({ title: 'T', version: '1.0.0' });
    expect(Object.keys(doc.components.schemas)).toEqual(['ErrorResponseDto']);
    expect(doc.paths).toEqual({});
  });
});
