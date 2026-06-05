# FE-1: Schema + Naming Groundwork Spec

**Parent:** docs/specs/2026-06-04-frontend-pipeline-rebuild.md (FE-1) · ADR-038
**Branch:** `fe-1/schema-naming-groundwork` off `feat/frontend-pipeline-rebuild`
**Status:** approved (parent spec gated 2026-06-04; e2e run authorized)

## Overview

Pure src-side groundwork, no emission change: (1) per-entity sync mode in the entity YAML schema, (2) a cross-entity naming registry in the parser for FK target resolution, (3) delete the dead `pipelines:` config surface.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/entity-definition.schema.ts` | modify | add `sync` to `EntityConfigSchema` |
| `src/parser/entity-registry.ts` | create | `loadEntityRegistry()` |
| `src/parser/index.ts` | modify | export it |
| `src/schema/pipelines-config.schema.ts` | modify | delete `ArchitectureTargetSchema`, `BackendPipelineSchema`, `FrontendPipelineSchema`, `SharedPipelineSchema`, `PipelinesConfigSchema`, both `validate*` helpers. KEEP `GenerateConfigSchema`, `PathsConfigSchema`, `PatternsConfigSchema`, `RuntimeModeSchema` |
| `src/config/config-loader.ts` | modify | drop pipelines import/validation block + `ProjectConfig.pipelines` field + stale doc comments |
| `src/config/paths.mjs` | modify | delete `getPipelinesConfig` (def ~line 622 + export ~684 + doc example ~619) |
| `templates/entity/new/prompt.js` | modify | drop the `getPipelinesConfig` import (line 23) — its only reference |
| `src/__tests__/schema/schema-v2.test.ts` | modify | delete the `pipelines config` describe block (~line 264); add `entity.sync` cases |
| `src/__tests__/parser/entity-registry.test.ts` | create | registry tests |
| `test/fixtures/codegen.config.yaml` | modify | remove the `pipelines:` block (lines `pipelines:` … `enabled: true` before `generate:`) |
| `docs/specs/2026-06-04-frontend-pipeline-rebuild.md` | modify | record refinement: `sync:` lives inside the `entity:` block (strict schema, sibling to `surface:`/`context:`), not top-level |

## Interface

```ts
// src/schema/entity-definition.schema.ts — inside EntityConfigSchema, sibling to `surface:`
// ADR-038: per-entity frontend sync mode. Overrides global frontend.sync.mode.
//   'api'      → queryCollectionOptions (REST via TanStack Query)
//   'electric' → electricCollectionOptions (real-time shape sync)
// 'offline' (Electric + Dexie) is deferred — see docs/specs/2026-06-04-frontend-pipeline-rebuild.md OQ-6.
sync: z.enum(['api', 'electric']).optional(),
```

```ts
// src/parser/entity-registry.ts
export interface EntityRegistryEntry {
  name: string;          // 'deal_state'
  plural: string;        // authoritative, from YAML entity.plural
  table: string;
  className: string;     // 'DealState'  (pascal of name)
  classNamePlural: string;
  camelName: string;     // 'dealState'
  pluralCamelName: string;
  sync: 'api' | 'electric' | null;   // null → inherit global frontend.sync.mode
}

export interface LoadEntityRegistryResult {
  registry: Map<string, EntityRegistryEntry>;  // keyed by entity name
  issues: AnalysisIssue[];                     // invalid YAMLs reported, not thrown
}

export function loadEntityRegistry(entitiesDir: string): LoadEntityRegistryResult;
```

## Implementation Steps

1. Branch `fe-1/schema-naming-groundwork` from `feat/frontend-pipeline-rebuild` (current HEAD).
2. Add `sync` to `EntityConfigSchema` with the comment above (match the house style of `surface:`/`context:` entries).
3. `entity-registry.ts`: glob `*.yaml`/`*.yml` under `entitiesDir`, load via the existing schema-validated loader (`loadEntityFromYaml` from `src/utils/yaml-loader`, re-exported by `src/parser/index.ts`), tolerant of invalid files (mirror `loadEntities`' issue-collection pattern — see `loadErrorToIssue`). Derive casings with existing naming helpers if exported; else local `pascalCase`/`camelCase` consistent with `prompt.js`. **Never derive plural — read it from the YAML.**
4. Delete the pipelines schema surface per the Files table. Check for any straggler imports (`grep -rn "PipelinesConfig\|getPipelinesConfig\|FrontendPipelineSchema"`).
5. Update tests + fixture; add registry tests covering: two entities with cross-references; an irregular/explicit plural (e.g. `person` with `plural: people`) asserting the registry returns the YAML plural; `sync` round-trip; invalid-YAML tolerance.
6. Update the parent spec's FE-1 + "New" sections with the `entity.sync` placement refinement (one sentence).
7. Run `just test-unit` — must pass. Run `bunx tsc --noEmit` if the project typechecks (check package.json scripts; use the project's own check script if present).
8. Conventional commit(s) on the branch. End commit body with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Constraints

- Do NOT touch `templates/entity/new/frontend/**` (FE-2/FE-3 delete them wholesale).
- Do NOT start the emitter.
- No deprecation shims, no "deprecated" comments — delete cleanly (CLAUDE.md operating principle).
- `schema-v2.test.ts` line 268 references `FrontendPipelineSchema` types — that whole describe dies with the schema.

## Open Questions

None — all resolved in parent spec / ADR-038.
