# OPENAPI-1 — Registry + optional peer dep

**Epic:** #TBD (OpenAPI Phase 1)
**Depends on:** none
**Blocks:** OPENAPI-2, OPENAPI-3, OPENAPI-4

## Scope

Vendor the `OpenApiRegistry` helper into `runtime/shared/openapi/`. Adopt `@anatine/zod-openapi` as an **optional peer dep** (lazy-imported on first use — matches `analytics/cube-backend.ts` precedent). Export DI token `OPENAPI_REGISTRY`.

## Files

### NEW
- `runtime/shared/openapi/registry.ts` — `OpenApiRegistry` class (wraps `@anatine/zod-openapi`); exposes `registerSchema(name, zodSchema)`, `registerPath(path, method, spec)`, `build(): OpenAPIObject`. Throws `OpenApiPeerDepMissingError` on first use if `@anatine/zod-openapi` is not installed.
- `runtime/shared/openapi/index.ts` — barrel: `OpenApiRegistry`, `OPENAPI_REGISTRY`, `OpenApiPeerDepMissingError`.
- `runtime/shared/openapi/registry.tokens.ts` — `OPENAPI_REGISTRY = Symbol('OPENAPI_REGISTRY')`.
- `src/__tests__/runtime/shared/openapi-registry.spec.ts` — tests below.

### MODIFY
- `package.json` — add `@anatine/zod-openapi` to `peerDependenciesMeta` as optional.

## Protocol sketch

```ts
export class OpenApiRegistry {
  private zodSchemas = new Map<string, z.ZodType>();
  private paths: OpenApiPathEntry[] = [];

  registerSchema(name: string, schema: z.ZodType): void;
  registerPath(path: string, method: 'get'|'post'|'patch'|'delete', spec: PathSpec): void;
  build(info: { title, version, description? }): OpenAPIObject;  // invokes lazy-imported peer
  reset(): void;  // test helper
}
```

Lazy-import pattern (from `analytics/cube-backend.ts`):

```ts
private async loadPeer() {
  try {
    const mod = await import('@anatine/zod-openapi');
    this.peer = mod;
  } catch (err) {
    throw new OpenApiPeerDepMissingError(
      'OpenApiRegistry requires @anatine/zod-openapi. Install it: bun add @anatine/zod-openapi'
    );
  }
}
```

## Tests (unit)

1. `registerSchema` + `build` round-trip — simple Zod object schema (e.g., `z.object({ id: z.string().uuid(), name: z.string() })`) produces correct OpenAPI JSON schema via `generateSchema` from the peer.
2. `registerPath` entries appear in `build()` output under `paths.{path}.{method}`.
3. `registerSchema('User', ...)` twice throws `DuplicateSchemaError` (or logs warning + overwrites — pick one, document in PR body).
4. `build()` called before any `registerSchema` returns a valid `OpenAPIObject` with empty `components.schemas`.
5. `OpenApiPeerDepMissingError` thrown on `build()` when peer is not resolvable (mock by overriding `import`).
6. Emitted `OpenAPIObject` is version 3.0.3 (lock in test — if bumped, that's a conscious choice).

## Acceptance

- [ ] `runtime/shared/openapi/` exists with registry + tokens + barrel.
- [ ] `@anatine/zod-openapi` listed as optional peer; generated apps that don't install it still boot.
- [ ] 6+ unit tests; all green.
- [ ] `just test-unit` passes.
- [ ] Doc comment on `OpenApiRegistry` cites the lazy-import pattern and OPENAPI-2 as the consumer.

## Gate

**CHECKPOINT** after merge. Coordinator reports: registry shape, peer-dep wiring sanity check, lazy-import behavior confirmed.

## Implementation notes (post-merge)

Decisions locked during implementation that deviate from the pre-implementation sketch:

- **`OPENAPI_REGISTRY` is a string constant**, not a `Symbol`. Matches the convention used by `runtime/subsystems/analytics/analytics.tokens.ts` and `runtime/subsystems/bridge/bridge.tokens.ts` (value-equal across import boundaries; bridge docs the reason inline).
- **`build()` is async** (`Promise<OpenAPIObject>`). The `@anatine/zod-openapi` peer is lazy-imported on first use per the `analytics/cube-backend.ts` pattern; synchronous `build()` would require a pre-init step or a synchronous load, both worse than awaiting at boot. OPENAPI-4's Swagger bootstrap awaits once at startup.
- **Duplicate `registerSchema(name, ...)` throws `DuplicateSchemaError`.** Silent overwrite was rejected as too surprising.
- **Peer API shape:** `@anatine/zod-openapi@^2.2.8` exports `generateSchema(zodRef, useOutput?, version?)` returning a single `SchemaObject` — NOT an `OpenAPIGenerator` producing a full document. The registry assembles the top-level `OpenAPIObject` itself (`openapi: '3.0.3'`, `info`, `paths`, `components.schemas`) and calls `generateSchema(..., false, '3.0')` per registered schema.
- **`OpenAPIObject` typed locally** — `openapi3-ts` was not added as a dep. The local interface covers what OPENAPI-2/3/4 need; if downstream wants richer typing, pulling `openapi3-ts` in as a dev dep is one line.
- **`loadPeer` is `protected`** (not `private`) so tests can subclass to exercise the try/catch path directly. Minor access-level relaxation for testability.
- Peer resolution **caches on success only** — a failed load throws each time, so installing the peer after the first attempt and retrying works without a process restart.
