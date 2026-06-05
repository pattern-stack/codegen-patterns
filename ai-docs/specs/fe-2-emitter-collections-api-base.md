# FE-2: Frontend Emitter — Collections + API Client + Base Files

**Parent:** docs/specs/2026-06-04-frontend-pipeline-rebuild.md (FE-2) · ADR-038
**Branch:** `fe-2/emitter-collections-api-base` off `fe-1/schema-naming-groundwork`
**Status:** approved (parent spec gated; e2e run authorized)

## Overview

First half of the whole-set TypeScript emitter at `src/emitters/frontend/` (NEW directory — deliberately NOT `src/cli/`, per the standing emitter-relocation intent): per-entity collections, per-entity REST api client, and the base files (`query-client.ts`, `config.ts`). Library + tests only — **no CLI wiring** (FE-4). Deletes the hygen collections templates it replaces.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/emitters/frontend/types.ts` | create | `FrontendEmitContext` |
| `src/emitters/frontend/emit-utils.ts` | create | banner + file-writing helpers |
| `src/emitters/frontend/deps.ts` | create | version-pairing constant |
| `src/emitters/frontend/emit-collections.ts` | create | per-entity collection + `collections/index.ts` |
| `src/emitters/frontend/emit-api.ts` | create | `api/client.ts`, `api/<entity>.ts`, `api/index.ts` |
| `src/emitters/frontend/emit-base.ts` | create | `query-client.ts`, `config.ts` |
| `src/emitters/frontend/index.ts` | create | `emitFrontendSet()` (FE-2 scope: collections+api+base; FE-3 extends) |
| `src/__tests__/emitters/frontend/emit-collections.test.ts` | create | incl. the 3 cases ported from frontend-sync-mode.test.ts |
| `src/__tests__/emitters/frontend/emit-api.test.ts` | create | routes, verbs, auth, baseURL variants |
| `src/__tests__/emitters/frontend/emit-base.test.ts` | create | query-client + config emission |
| `templates/entity/new/frontend/collections/**` (5 files) | **delete** | replaced by emit-collections |
| `src/__tests__/clean-lite-ps/frontend-sync-mode.test.ts` | **delete** | tested the deleted template; its cases move to emit-collections.test.ts |

## Interface

```ts
// types.ts
import type { ParsedEntity } from '../../parser/...';          // reuse parser types
import type { EntityRegistryEntry } from '../../parser/entity-registry';

export type SyncMode = 'api' | 'electric';

export interface FrontendEmitConfig {
  globalSyncMode: SyncMode;                  // frontend.sync.mode ?? 'electric'
  authFunction: string | null;               // frontend.auth.function (null = disabled)
  authImport: string;                        // locations.frontendCollectionsAuth.import
  shapeUrl: string;                          // frontend.sync.shapeUrl ?? '/v1/shape'
  useTableParam: boolean;
  columnMapper: string | null;
  columnMapperNeedsCall: boolean;
  apiUrl: string;                            // frontend.sync.apiUrl ?? '/api'
  apiBaseUrlImport: string | null;           // emits `import { API_BASE_URL } from ...`
  parsers: Record<string, string>;           // type → fn source (electric parser block)
  architecture: 'clean' | 'clean-lite-ps';   // update verb: clean→PUT, clean-lite-ps→PATCH
  dbEntitiesImport: string;                  // locations.dbEntities.import (schema/type imports)
}

export interface FrontendEmitContext {
  entities: EntityRegistryEntry[];           // full set, deterministic order (sort by name)
  config: FrontendEmitConfig;
}

// each emit module exports pure string builders + a write step:
export function buildCollectionFile(e: EntityRegistryEntry, ctx: FrontendEmitContext): string;
export function emitCollections(ctx: FrontendEmitContext, outDir: string): string[]; // written paths
// (same pattern in emit-api / emit-base)

// index.ts
export function emitFrontendSet(ctx: FrontendEmitContext, outDir: string): string[];
```

Pure builders make tests string-level (no fs) — mirror the deleted frontend-sync-mode.test.ts technique.

## Emission shapes

**Collections** (`collections/<name>.ts`): resolve mode = `entity.sync ?? config.globalSyncMode`.
- *electric*: port the electric branch of the deleted `collections/collection.ejs.t` — `electricCollectionOptions({ id: plural, shapeOptions: { url (useTableParam → table param form; with `typeof window !== 'undefined'` SSR guard — adopt the guard everywhere, it was inconsistent in the templates), headers (auth fn), parser (parsers block), columnMapper (needsCall) }, schema: <camel>Schema, getKey })`. Schema named import from `${dbEntitiesImport}/<name>` (direct named import — `schemaPrefix` is dead per parent spec).
- *api*: `queryCollectionOptions({ id, queryKey: [plural], queryClient (import from '../query-client'), queryFn: fetch via the api client → import { <camel>Api } from '../api/<name>' and call `.list()` (do NOT inline a fetch — the api client owns transport), getKey, schema })`.
- `collections/index.ts`: `export * from './<name>'` per entity, sorted.

**API client** (`api/client.ts`): `request<T>(method, path, body?)` — baseURL = `apiBaseUrlImport ? API_BASE_URL : '<apiUrl>'`; auth header via `authFunction` import when set; non-ok → `throw new Error(\`<METHOD> <path> → ${status} ${statusText}\`)`; JSON parse; 204 → undefined.
**`api/<entity>.ts`**: `<camel>Api = { list(): Promise<T[]> GET /<plural>; get(id) GET /<plural>/:id; create(data) POST /<plural>; update(id, data) <PUT|PATCH per architecture> /<plural>/:id; delete(id) DELETE /<plural>/:id }` with `import type { <Class>Entity? no — type names come from dbEntities: import type { <Class> } ...` — use the registry `className`; type import from `${dbEntitiesImport}/<name>`. Note: typeNaming knob is dead; emit plain `<Class>` (the `packages/db` Zod schemas export plain names — confirm against a `templates/entity/new/` schema template and match what's actually exported; if both `<Class>` and `<Class>Entity` exist prefer plain).

**Base**: `query-client.ts` — port pts `query_client.ts.j2` verbatim (staleTime 60s, gcTime 5m, replaceability comment). `config.ts` — port pts `config.ts.j2`: `type SyncMode = 'api' | 'electric'` (NO 'offline' — deferred, comment points at parent spec OQ-6), `defaultConfig` from per-entity resolved modes, `getSyncMode(entity)`, `setEntityConfig(entity, cfg)` runtime override.

All files start with the house `@generated` banner — mirror `generatedBanner()` in `src/cli/shared/adapter-emission-generator.ts:204` (extract the FE copy into `emit-utils.ts`; do not import across from cli/shared — emitters must not depend on cli/).

**Version pairing** (`deps.ts`): the parent-spec table as `export const FRONTEND_EMITTED_DEPS = { '@pattern-stack/frontend-patterns': '^0.2.0-alpha.18', '@tanstack/react-db': '^0.1.55', '@tanstack/electric-db-collection': '^0.2.11', '@tanstack/query-db-collection': '^1.0.6', '@tanstack/react-query': '^5.0.0' } as const;`

## Tests (string-level, bun:test)

- electric default: `electricCollectionOptions`, shapeOptions, no `queryCollectionOptions`, SSR guard present
- api mode: `queryCollectionOptions`, queryKey, api-client import, no shapeOptions
- per-entity override: ctx global electric + one entity `sync: 'api'` → that entity gets api branch, siblings electric
- API_BASE_URL variant (apiBaseUrlImport set) in client.ts
- auth on/off (null authFunction emits no header lines)
- update verb: clean → PUT; clean-lite-ps → PATCH
- config.ts: per-entity modes table; no 'offline' anywhere
- determinism: same ctx → byte-identical output, entities emitted sorted

## Implementation Steps

1. Branch `fe-2/emitter-collections-api-base` off `fe-1/schema-naming-groundwork` HEAD.
2. types/emit-utils/deps first; then emit-base, emit-api, emit-collections; then index.ts.
3. Delete `templates/entity/new/frontend/collections/` and `src/__tests__/clean-lite-ps/frontend-sync-mode.test.ts`.
4. `just test-unit` green; `just test-baseline` green (baseline has `generate.frontend: false` — must be unaffected); typecheck no NEW errors (3 pre-existing in junction.ts/barrel-generator.ts are known).
5. Conventional commit; Co-Authored-By trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do not push.

## Constraints

- No CLI wiring, no prompt.js changes, no deletion outside the two listed paths.
- Emitters must not import from `src/cli/**`.
- Mid-stack note (accepted): with collections templates deleted and the emitter unwired, hygen no longer emits collections.ts until FE-4 — fine inside the stack.
- If the dbEntities schema export check (plain vs Entity-suffixed) is ambiguous, emit plain and record the finding in the report.
