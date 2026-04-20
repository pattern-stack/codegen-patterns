# JOB-7 — `scopeable: true` Entity Flag and Generated `ScopeEntityType` Union

**Issue:** JOB-7
**Status:** Implemented
**Last Updated:** 2026-04-20
**Phase:** ADR-022 Phase 1
**Depends on:** JOB-1 (`scope_entity_type text?` column consumes this union), JOB-2 (`ScopeRef<TInput, TScope extends string>` references this union)
**Blocks:** JOB-8 (uses same entity scan infrastructure for `multi_tenant` flag)

## Overview

Add `scopeable: true` to entity YAML definitions and generate a typed `ScopeEntityType` TypeScript union and Zod enum from the set of all flagged entities. The union is written to `runtime/subsystems/jobs/generated/scope-entity-type.ts` in the consumer project. Type safety lives at the TS layer; the `scope_entity_type` DB column remains `text` with no CHECK constraint (ADR-022 mandate). Codegen-only change: no DB migrations, no new runtime classes.

## Context

**What exists.** Entity YAML is validated by `EntityDefinitionSchema` (Zod) in `src/schema/entity-definition.schema.ts`. The `entity:` block is parsed by `EntityConfigSchema` which uses `.strict()` — unrecognized keys are rejected. The parser (`src/parser/load-entities.ts`) transforms validated YAML into `ParsedEntity` via `transformToEntity`. The CLI (`src/cli/commands/entity.ts`) calls Hygen per entity then runs `regenerateBarrels()` as a cross-entity post-step.

`regenerateBarrels()` in `src/cli/shared/barrel-generator.ts` is the precedent: walks the entities directory, calls `loadEntityFromYaml` on each file, builds content from the full set, writes directly to disk (no Hygen). JOB-7 follows this pattern.

**What JOB-7 adds.**
1. `scopeable: z.boolean().optional()` in `EntityConfigSchema`
2. `scopeable?: boolean` on `ParsedEntity`
3. New `generateScopeEntityType()` in `src/cli/shared/scope-entity-type-generator.ts`
4. Call site in `EntityNewCommand.execute()` alongside `regenerateBarrels()`

No Hygen templates — direct TypeScript string generation.

## Architecture

```
EntityNewCommand.execute()
  ├── invokeEntityNew() × N           ← Hygen, unchanged
  ├── regenerateBarrels()             ← existing post-step
  └── generateScopeEntityType()       ← new post-step (JOB-7)
        ├── collectScopeableNames(entitiesDir)
        │     └── loadEntityFromYaml per file; filter scopeable === true
        ├── buildScopeEntityTypeContent(names)  ← pure function
        └── write runtime/subsystems/jobs/generated/scope-entity-type.ts
```

Deterministic: full directory rescan on every invocation. Adding/removing `scopeable: true` and rerunning `entity new` always yields correct union.

## Files

| File | Action | Purpose |
|---|---|---|
| `src/schema/entity-definition.schema.ts` | modify | Add `scopeable: z.boolean().optional()` to `EntityConfigSchema` |
| `src/analyzer/types.ts` | modify | Add `scopeable?: boolean` to `ParsedEntity` |
| `src/parser/load-entities.ts` | modify | Populate `entity.scopeable` in `transformToEntity` |
| `src/cli/shared/scope-entity-type-generator.ts` | create | `generateScopeEntityType()` + helpers |
| `src/cli/commands/entity.ts` | modify | Invoke generator after `regenerateBarrels()` |
| `src/__tests__/schema/schema-v2.test.ts` | modify | `scopeable` field validation cases |
| `src/__tests__/cli/scope-entity-type-generator.test.ts` | create | Unit tests for generator |
| `test/baseline/` | modify | Update snapshot to include generated union |

## Interfaces

### Schema change (`entity-definition.schema.ts`)

```typescript
const EntityConfigSchema = z.object({
  name: z.string().regex(...),
  plural: z.string().regex(...),
  table: z.string().regex(...),
  folder_structure: FolderStructureSchema.optional(),
  file_grouping: FileGroupingSchema.optional(),
  behavior_strategy: BehaviorStrategySchema.optional(),
  expose: z.array(ExposeLayerSchema).optional().default([...]),
  family: z.enum([...]).optional(),
  scopeable: z.boolean().optional(),    // ← ADD
}).strict();
```

### `ParsedEntity` extension (`src/analyzer/types.ts`)

```typescript
export interface ParsedEntity {
  // ... existing fields ...
  scopeable?: boolean;   // ← ADD
  sourcePath: string;
}
```

### Parser population (`src/parser/load-entities.ts`)

```typescript
// inside transformToEntity, next to `family`:
const entity: ParsedEntity = {
  // ... existing ...
  family: definition.entity.family,
  scopeable: definition.entity.scopeable ?? false,   // ← ADD
  // ... rest ...
};
```

### Generator (`src/cli/shared/scope-entity-type-generator.ts`)

```typescript
interface ScopeEntityTypeGeneratorOptions {
  entitiesDir: string;        // absolute
  outputPath: string;         // absolute, default <cwd>/runtime/subsystems/jobs/generated/scope-entity-type.ts
  dryRun?: boolean;
}

interface ScopeEntityTypeResult {
  outputPath: string;
  scopeableNames: string[];   // sorted
  written: boolean;
  content: string;
}

function collectScopeableNames(entitiesDir: string): string[];
// Walk directory; loadEntityFromYaml; filter; sort; return names

function buildScopeEntityTypeContent(names: string[]): string;
// Pure function. See "Generated output" below for both the non-empty and empty cases.

export async function generateScopeEntityType(
  opts: ScopeEntityTypeGeneratorOptions,
): Promise<ScopeEntityTypeResult>;
// Calls collect + build; fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync unless dryRun
```

## Generated Output

With `account` and `opportunity` as `scopeable: true`, `contact` as not:

```typescript
// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.
// Run `codegen entity new --all` to refresh.

import { z } from 'zod';

export type ScopeEntityType = 'account' | 'opportunity';

export const SCOPE_ENTITY_TYPES = ['account', 'opportunity'] as const;

export const scopeEntityTypeSchema = z.enum(['account', 'opportunity']);
```

Empty case (no scopeable entities):

```typescript
// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.
// Run `codegen entity new --all` to refresh.

export type ScopeEntityType = never;

export const SCOPE_ENTITY_TYPES = [] as const;
```

No Zod import when empty (`z.enum([])` is invalid).

**Consumer usage** (matches JOB-2's `ScopeRef<TInput, TScope extends string>`):

```typescript
// import path is consumer-project-relative; use a tsconfig path alias (e.g. @jobs/*)
// pointing to `runtime/subsystems/jobs/generated/` if desired.
import type { ScopeEntityType } from '../../../subsystems/jobs/generated/scope-entity-type';

@JobHandler<OnboardingInput>('onboarding', {
  scope: { entity: 'account' satisfies ScopeEntityType, from: (i) => i.accountId },
})
```

`satisfies ScopeEntityType` enforces compile-time membership without literal widening.

## Implementation Steps

1. **Extend `EntityConfigSchema`** — add `scopeable: z.boolean().optional()` after `family`. `.strict()` stays.
2. **Extend `ParsedEntity`** — add `scopeable?: boolean`.
3. **Populate in parser** — `scopeable: definition.entity.scopeable ?? false` in `transformToEntity`.
4. **Create generator** — `scope-entity-type-generator.ts` with `collectScopeableNames`, `buildScopeEntityTypeContent`, `generateScopeEntityType`. Match `barrel-generator.ts` style (HEADER constant, `mkdirSync`, same dry-run semantics).
5. **Wire into `EntityNewCommand`** — after `regenerateBarrels()`, call `generateScopeEntityType({ entitiesDir, outputPath: path.resolve(ctx.cwd, 'runtime/subsystems/jobs/generated/scope-entity-type.ts'), dryRun: this.dryRun })`. Include in dry-run report. Warn-but-don't-fail on error (matches barrel pattern). Run for both single-file and `--all` modes.
6. **Add unit tests** — schema tests for field validation; generator tests with temp-directory fixtures.
7. **Update baseline** — ensure one baseline fixture has `scopeable: true` so snapshot exercises non-empty path.

## Acceptance Criteria

- [x] `scopeable: true` passes `EntityDefinitionSchema.parse()`
- [x] `scopeable: false` passes
- [x] Omitting `scopeable` passes (`.optional()`)
- [x] Non-boolean values rejected by Zod
- [x] `transformToEntity` produces `entity.scopeable === true` for flagged entity, `false` otherwise
- [x] Given `account` (scopeable) + `contact` (not): union = `'account'`; `contact` absent
- [x] Given zero scopeable: `ScopeEntityType = never`, no Zod import
- [x] Generated file has `// AUTO-GENERATED` header
- [x] `entity new --all` regenerates union after Hygen
- [x] `entity new entities/X.yaml` also regenerates (full directory rescan)
- [x] `--dry-run` reports planned output without writing
- [x] `just test-unit` + `just test-baseline` pass

## Testing Strategy

**Unit — Zod schema** (`schema-v2.test.ts` extension):
- `scopeable: true` → valid
- `scopeable: false` → valid
- absent → valid, `undefined`
- non-boolean → rejected

**Unit — Generator** (`scope-entity-type-generator.test.ts`):
- `buildScopeEntityTypeContent([])` → `never` form, no Zod import
- `buildScopeEntityTypeContent(['account'])` → single-member union + Zod enum
- `buildScopeEntityTypeContent(['account', 'opportunity'])` → sorted union
- `collectScopeableNames(tempDir)` with two fixture YAMLs (one scopeable, one not) → returns only scopeable name
- `generateScopeEntityType({ dryRun: true })` → `written: false`, correct `content`

**Baseline**: amend existing fixture (e.g. `opportunity.yaml`) to include `scopeable: true`; snapshot includes `scope-entity-type.ts`.

All tests run via `just test-unit` / `just test-baseline`. No Docker.

## Scope Boundary

**In scope:** YAML flag, parser collection, union generation.

**Out of scope:**
- Multi-tenancy `tenant_id` threading (JOB-8)
- Generating helper methods on `JobRunService` — those are consumer use cases calling existing `IJobRunService.listForScope(entityType, entityId)` from JOB-2/JOB-3
- DB CHECK constraint on `scope_entity_type` — ADR-022 prohibits
- Per-entity Hygen template changes
- Validating `@JobHandler` `scope.entity` value is a `ScopeEntityType` member — consumer enforces via `satisfies`

## Open Questions

- [x] **OQ-1 — Single-file vs. `--all` trigger.** **Resolved 2026-04-18: always rescan.** Both single-file and `--all` invocations trigger a full directory rescan and union regeneration. Cost is one directory walk (sub-millisecond at typical entity counts). Correctness over speed — silent stale-union failures would be confusing.

- [x] **OQ-2 — Consumer output path.** **Resolved 2026-04-19 (Q5): hardcoded `runtime/subsystems/jobs/generated/scope-entity-type.ts` — co-located with the jobs subsystem scaffold.** Establishes the `generated/` convention for subsystem-owned generated types (the forthcoming events epic will follow the same pattern for `AppDomainEvent`). Supersedes the 2026-04-18 proposal of `src/shared/jobs/...`. Rationale: clearer ownership — the jobs subsystem owns the type — and avoids a cross-cutting `@shared/` path.

- [x] **OQ-3 — Empty Zod enum.** **Resolved 2026-04-18: omit the Zod export entirely when no scopeable entities exist.** Importers of `scopeEntityTypeSchema` get a clear "not exported" build error — correct surfacing of "there are no valid scopes." Fallbacks (`z.never()`, `z.string()`) hide the problem.

- [x] **OQ-4 — `scopeable` placement.** **Confirmed: inside `entity:` block (`EntityConfigSchema`).**

- [x] **OQ-5 — Sort order.** **Confirmed: alphabetical.** Deterministic; adding a new entity in the middle doesn't reorder existing entries; baseline-stable.

## References

- ADR-022 "Scoping" section
- `docs/specs/ADR-022-phase-1-issues.md` — JOB-7 entry
- `docs/specs/JOB-2.md` — `ScopeRef` generic + OQ-2 path decision
- `src/cli/shared/barrel-generator.ts` — precedent pattern for cross-entity TS artifacts
- `src/schema/entity-definition.schema.ts` — modification target
- `src/parser/load-entities.ts` — modification target
- `src/analyzer/types.ts` — modification target
- `src/__tests__/schema/schema-v2.test.ts` — extension target
