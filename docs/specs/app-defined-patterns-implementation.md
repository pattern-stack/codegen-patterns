# App-Defined Patterns — Implementation Spec

**RFC:** `docs/RFC-app-defined-patterns.md`
**ADR:** `docs/adrs/ADR-031-app-defined-patterns.md` (the binding decisions)
**Status:** Accepted (ADR-locked)
**Date:** 2026-04-19 (revised from 2026-04-18 draft)
**Scope:** codegen-patterns library changes — Phase 1 only. First consumer integration (dealbrain-v2 `CrmEntityPattern`) is Phase 2.

> **Vocabulary note (2026-05-30, ADR-0005):** This spec predates the `sync`→`integration` rename (shipped in 0.11.0). Where it references the `Synced` family / `SyncedEntityRepository` / `SyncedPattern` / `SyncUpsertConfig`, read `Integrated` / `IntegratedEntityRepository` / `IntegratedPattern` / `IntegrationUpsertConfig`. The pattern mechanism is unchanged. See swe-brain `ADR-0005-rename-sync-to-integration` and the 0.11.0 CHANGELOG.

> **Living-document note (2026-04-19):** This spec was originally drafted before the understand phase examined the existing codebase. Three earlier proposals (a `family:` deprecation alias with `console.warn`, a `generate.patterns` opt-in feature flag, and a `static readonly patternConfig` runtime accessor) contradicted both CLAUDE.md ("no backwards compatibility until users") and the existing `behaviors: BehaviorConfig` instance-property convention in `templates/entity/new/clean-lite-ps/repository.ejs.t`. ADR-031 documents the resolution; this spec was rewritten in the same commit to reflect the final shape.
>
> **Post-implementation revision (2026-04-21, PATTERN-5):** every file listed in §7 shipped. Three details discovered during implementation and worth pinning here:
> 1. **Baseline regen was not required.** PATTERN-3's template bridge (single-line change in `prompt-extension.js` that lowercased `entity.pattern` to index the legacy FAMILY_MAP) produces byte-identical output for all library patterns. PATTERN-5's registry swap preserved that property, so `just test-baseline` passes against the unmodified `test/baseline/` snapshot. The integration gate from `PATTERNS-PHASE-1-PLAN.md` ("byte-identical output for an unchanged fixture") is met transitively through PATTERN-3.
> 2. **`renderPatternConfigLiteral()` helper added to prompt-extension.js.** The spec's §6 example shows `patternConfig = { entityType: 'opportunity' } as const;` with bare identifier keys and single-quoted strings. A naive `JSON.stringify(patternConfig, null, 2)` emits `{"entityType": "opportunity"}` — valid TS but not idiomatic and brittle under consumer linters. The helper emits the ADR's style directly; unit-tested in `src/__tests__/clean-lite-ps/prompt-extension.test.ts`.
> 3. **`analyzeDomain()` signature widened non-breakingly.** To plumb `generate.architecture` into the PATTERN-4 project-level warning (clean-pipeline no-op), the second positional argument now accepts either a relationships-dir string (legacy) or an options object `{ relationshipsDir?, architecture? }`. Existing callers (CLI `entity validate`, `project graph`) keep working; pattern-aware callers opt in via the object form.

---

## 1. `definePattern()` API

A `PatternDefinition` is a pure metadata record, returned by an identity function. The class constructors referenced by `repositoryClass` / `serviceClass` are never imported by codegen — only their names and import paths are. This keeps Hygen's subprocess registry-build cheap (no TS class evaluation, no `reflect-metadata`).

```typescript
// src/patterns/pattern-definition.ts  (NEW — library)

import type { ZodSchema } from "zod";

export interface PatternColumnContribution {
  name: string;          // snake_case column name
  type: string;          // drizzle column type string (e.g. "varchar(255)")
}

export interface PatternDefinition<TConfig = unknown> {
  name: string;
  extends?: string[];
  repositoryClass?: string;
  serviceClass?: string;
  repositoryImport?: string;     // fully-qualified TS path-alias
  serviceImport?: string;
  repositoryInheritedMethods?: string[];
  serviceInheritedMethods?: string[];
  columns?: PatternColumnContribution[];
  impliedBehaviors?: string[];
  configSchema?: ZodSchema<TConfig>;
  description?: string;
}

export function definePattern<TConfig = unknown>(
  def: PatternDefinition<TConfig>,
): PatternDefinition<TConfig> {
  return def;
}
```

At least one of `columns`, `repositoryClass`, or `serviceClass` must be present (validated when the registry collects the definition). The `extends` chain is single-depth in Phase 1 — see ADR-031 §"Consequences" for the deferral rationale.

---

## 2. YAML Schema

Per ADR-031, the legacy `family:` enum is **deleted** in the same change that introduces `pattern:`. No alias, no console.warn, no deprecation window. Every fixture and consumer YAML migrates from `family: <name>` → `pattern: <Name>` in one sweep.

### Current state (`src/schema/entity-definition.schema.ts:486–488`)

```typescript
family: z.enum(["base", "synced", "activity", "knowledge", "metadata"]).optional(),
```

### Target state

```typescript
const EntityConfigSchema = z.object({
  // ... existing fields (name, plural, table, folder_structure, file_grouping,
  //                     behavior_strategy, expose) unchanged ...

  // NEW: single pattern by name (resolved from registry at codegen time)
  pattern: z.string().optional(),

  // NEW: multi-pattern composition
  patterns: z.array(z.string()).optional(),

  // NEW: per-pattern config block (key = pattern name, value = pattern's
  // configSchema parses the value at parse time)
  config: z.record(z.string(), z.unknown()).optional(),
})
.refine(
  (d) => !(d.pattern && d.patterns),
  { message: "'pattern' and 'patterns' are mutually exclusive" },
)
.strict();
```

**No `family:` field.** A YAML using the legacy key fails at parse time with the standard "unknown key" Zod error.

### `ParsedEntity` (`src/analyzer/types.ts:87–100`)

The `family` field is removed; the bugged `EntityFamily` type alias (`'crm-synced'|'activity'|'knowledge'|'metadata'`, missing `'base'`) is deleted. Three new fields:

```typescript
export interface ParsedEntity {
  // ... existing fields (name, plural, table, folderStructure, fields,
  //                     relationships, behaviors, queries, sync, events,
  //                     sourcePath) unchanged ...

  pattern?: string;                            // single pattern name
  patterns?: string[];                         // multi-pattern names
  patternConfig?: Record<string, unknown>;     // per-pattern config, pre-validated
}
```

### Parser (`src/parser/load-entities.ts`)

The cast at line 69 (`definition.entity.family as EntityFamily | undefined`) is removed alongside its source field. New mapping:

```typescript
const entity: ParsedEntity = {
  name: definition.entity.name,
  // ...
  pattern: definition.entity.pattern,
  patterns: definition.entity.patterns,
  patternConfig: definition.entity.config,
  // ...
};
```

### Examples

```yaml
# Single pattern
entity:
  name: opportunity
  plural: opportunities
  table: opportunities
  pattern: Synced
behaviors:
  - timestamps
  - soft_delete

# Single pattern with config
entity:
  name: opportunity
  pattern: CrmEntity                     # app-defined; library-shipped CrmEntity is Phase 2
  config:
    CrmEntity:
      entityType: opportunity
behaviors:
  - timestamps
  - soft_delete

# Multi-pattern composition
entity:
  name: deal
  patterns: [CrmEntity, Event]
  config:
    CrmEntity: { entityType: opportunity }
    Event:
      states:
        qualifying:  [developing, closed_lost]
        developing:  [proposing, closed_lost]
        proposing:   [negotiating, closed_lost]
        negotiating: [closed_won, closed_lost]
      initial_state: qualifying
behaviors:
  - timestamps
  - soft_delete
```

---

## 3. Pattern Discovery + Registration

Per ADR-031, discovery uses **glob entries in `codegen.config.yaml`** with a sensible default. Library-shipped patterns are pre-registered by the codegen package and consumers do not list them.

```yaml
# codegen.config.yaml
patterns:
  - src/patterns/*.pattern.ts        # default if `patterns:` is absent
  - vendor/internal-patterns/*.pattern.ts
```

### Schema additions (`src/schema/pipelines-config.schema.ts`)

```typescript
export const PatternsConfigSchema = z.array(z.string()).optional().default(["src/patterns/*.pattern.ts"]);
export type PatternsConfig = z.infer<typeof PatternsConfigSchema>;
```

### `ProjectConfig` (`src/config/config-loader.ts`)

```typescript
export interface ProjectConfig {
  pipelines?: PipelinesConfig;
  generate?: GenerateConfig;
  patterns?: string[];                 // NEW: pattern manifest globs
  [key: string]: unknown;
}
```

### Pattern registry (`src/patterns/registry.ts` — NEW)

```typescript
import { glob } from "glob";
import path from "node:path";
import type { PatternDefinition } from "./pattern-definition.js";

const LIBRARY_PATTERNS: Map<string, PatternDefinition> = new Map();
const APP_PATTERNS: Map<string, PatternDefinition> = new Map();

export function registerLibraryPattern(def: PatternDefinition): void {
  LIBRARY_PATTERNS.set(def.name, def);
}

export function getPattern(name: string): PatternDefinition | undefined {
  return APP_PATTERNS.get(name) ?? LIBRARY_PATTERNS.get(name);
}

export function getAllPatternNames(): string[] {
  return [...LIBRARY_PATTERNS.keys(), ...APP_PATTERNS.keys()];
}

export async function loadAppPatterns(
  manifestPaths: string[],
  cwd: string,
): Promise<{ loaded: string[]; errors: string[] }> {
  const loaded: string[] = [];
  const errors: string[] = [];

  for (const raw of manifestPaths) {
    const expanded = await glob(raw, { cwd, absolute: true });
    for (const filePath of expanded) {
      try {
        const mod = await import(filePath) as Record<string, unknown>;
        for (const [key, val] of Object.entries(mod)) {
          if (key.endsWith("Pattern") && isPatternDefinition(val)) {
            APP_PATTERNS.set(val.name, val);
            loaded.push(val.name);
          }
        }
      } catch (err) {
        errors.push(`Failed to load pattern file ${filePath}: ${String(err)}`);
      }
    }
  }
  return { loaded, errors };
}

function isPatternDefinition(val: unknown): val is PatternDefinition {
  return (
    typeof val === "object" && val !== null &&
    "name" in val
  );
}
```

### Two-process registry load

Hygen runs as a subprocess (`src/cli/shared/hygen.ts:64`), so the registry is built twice per `entity new` invocation: once by the CLI (for `analyzeDomain`/`entity validate`/composition checks) and once by `templates/entity/new/prompt.js` (for template rendering). Both are deterministic side-effect-free reads of the same files. Cost: one extra dynamic import per pattern file per process.

---

## 4. Composition + Conflict Detection

Per ADR-031 §3, the conflict matrix is:

| Conflict | Mode |
|---|---|
| Two patterns contribute the same column name | Generation-time hard error |
| Pattern column conflicts with entity-declared field | Generation-time hard error |
| Pattern column conflicts with a behavior field | Generation-time hard error |
| Two patterns contribute methods with the same name | Caught by TS compilation at consumer |
| Two patterns require the same implied behavior | Silent dedup |
| Pattern referenced in YAML is not in the registry | Generation-time hard error |
| `config` block contains a key for an unused pattern | Generation-time warning |

### Validation pass (`src/patterns/validate-composition.ts` — NEW)

Mirrors the behavior conflict check in `src/behaviors/index.ts:81–117`.

```typescript
import type { ParsedEntity } from "../analyzer/types.js";
import { getPattern } from "./registry.js";
import { resolveBehaviorFields } from "../behaviors/index.js";

export interface CompositionIssue {
  severity: "error" | "warning";
  entity: string;
  message: string;
}

export function validatePatternComposition(entity: ParsedEntity): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const patternNames = entity.patterns ?? (entity.pattern ? [entity.pattern] : []);
  if (patternNames.length === 0) return issues;

  const columnSources = new Map<string, string>();

  for (const [name] of entity.fields) {
    columnSources.set(name, "entity field");
  }

  const behaviorFields = resolveBehaviorFields(entity.behaviors);
  for (const bf of behaviorFields) {
    if (columnSources.has(bf.name)) {
      issues.push({
        severity: "error",
        entity: entity.name,
        message: `Behavior field '${bf.name}' conflicts with entity field '${bf.name}'`,
      });
    }
    columnSources.set(bf.name, "behavior field");
  }

  for (const patternName of patternNames) {
    const def = getPattern(patternName);
    if (!def) {
      issues.push({
        severity: "error",
        entity: entity.name,
        message:
          `Unknown pattern '${patternName}'. ` +
          `Is it registered in codegen.config.yaml patterns: glob?`,
      });
      continue;
    }

    if (def.configSchema) {
      const rawConfig = entity.patternConfig?.[patternName];
      const result = def.configSchema.safeParse(rawConfig ?? {});
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
        issues.push({
          severity: "error",
          entity: entity.name,
          message: `Pattern '${patternName}' config invalid: ${detail}`,
        });
      }
    }

    for (const col of def.columns ?? []) {
      if (columnSources.has(col.name)) {
        issues.push({
          severity: "error",
          entity: entity.name,
          message:
            `Pattern '${patternName}' contributes column '${col.name}' which conflicts ` +
            `with ${columnSources.get(col.name)}.`,
        });
      }
      columnSources.set(col.name, `pattern '${patternName}'`);
    }
  }

  // Warn on `config:` keys for patterns the entity isn't using
  if (entity.patternConfig) {
    const declared = new Set(patternNames);
    for (const key of Object.keys(entity.patternConfig)) {
      if (!declared.has(key)) {
        issues.push({
          severity: "warning",
          entity: entity.name,
          message: `Config block has key '${key}' but pattern '${key}' is not declared`,
        });
      }
    }
  }

  return issues;
}
```

This pass runs in `analyzeDomain()` (`src/index.ts`) after `resolveReferences()`, before any template invocation.

---

## 5. Library-Shipped Patterns

### Directory layout

```
src/patterns/
  pattern-definition.ts        # PatternDefinition type + definePattern()
  registry.ts                  # Library + app registries + loadAppPatterns()
  validate-composition.ts      # Conflict detection pass
  index.ts                     # Barrel
  library/
    base.pattern.ts            # BasePattern (no contributions; identity for `extends: ['Base']`)
    synced.pattern.ts          # SyncedPattern — replaces family: synced
    activity.pattern.ts        # ActivityPattern — replaces family: activity
    knowledge.pattern.ts       # KnowledgePattern — replaces family: knowledge
    metadata.pattern.ts        # MetadataPattern — replaces family: metadata
```

The four runtime base classes (`runtime/base-classes/{synced,activity,knowledge,metadata}-entity-{repository,service}.ts`) are **untouched**. Pattern records reference them by string name + path-alias; the consumer-installed runtime stays where it is.

### `synced.pattern.ts` — representative example

```typescript
import { definePattern } from "../pattern-definition.js";

export const SyncedPattern = definePattern({
  name: "Synced",
  extends: ["Base"],
  repositoryClass: "SyncedEntityRepository",
  serviceClass: "SyncedEntityService",
  repositoryImport: "@shared/base-classes/synced-entity-repository",
  serviceImport: "@shared/base-classes/synced-entity-service",
  repositoryInheritedMethods: [
    "findById, findByIds, list, count, exists, create, update, delete, upsertMany",
    "findByExternalId, findAllByUserId, findVisibleByUserId, syncUpsert",
  ],
  serviceInheritedMethods: [
    "findById, findByIds, list, count, exists, create, update, delete",
    "findByExternalId, findAllByUserId, findVisibleByUserId",
  ],
  impliedBehaviors: ["external_id_tracking"],
  description: "External CRM/system sync columns and syncUpsert methods",
});
```

The other three library patterns (`Activity`, `Knowledge`, `Metadata`) follow the same shape with different class/import names + inherited-method comment lines, copied verbatim from the existing `FAMILY_MAP` in `templates/entity/new/clean-lite-ps/prompt-extension.js:14–83`.

### `BasePattern`

`BasePattern` exists as the parent of `extends: ['Base']` but contributes nothing — it's the identity element. Its presence keeps the `extends` chain explicit (every pattern declares its parent) without forcing every library pattern to define repeated id/timestamp columns (those are owned by `behaviors: [timestamps]` already).

```typescript
export const BasePattern = definePattern({
  name: "Base",
  repositoryClass: "BaseRepository",
  serviceClass: "BaseService",
  repositoryImport: "@shared/base-classes/base-repository",
  serviceImport: "@shared/base-classes/base-service",
  repositoryInheritedMethods: [
    "findById, findByIds, list, count, exists, create, update, delete, upsertMany",
  ],
  serviceInheritedMethods: [
    "findById, findByIds, list, count, exists, create, update, delete",
  ],
  description: "Identity pattern — base CRUD, no extra columns or methods",
});
```

---

## 6. Generated Output Shape

### Today (clean-lite-ps with `family: synced`)

```typescript
import { SyncedEntityRepository } from '@shared/base-classes/synced-entity-repository';
// ...

@Injectable()
export class OpportunityRepository extends SyncedEntityRepository<Opportunity> {
  readonly table = opportunities;
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: true,
    softDelete: true,
    userTracking: false,
  };
  constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
}
```

### After (clean-lite-ps with `pattern: Synced`)

**Identical output.** `SyncedPattern` resolves to the same `repositoryClass: 'SyncedEntityRepository'` + `repositoryImport: '@shared/base-classes/synced-entity-repository'` that `family: synced` resolved to. No `patternConfig` is emitted because `SyncedPattern` has no `configSchema`.

### After (clean-lite-ps with `pattern: CrmEntity` + config)

```typescript
import { CrmEntityRepository } from '@/patterns/crm-entity.pattern';
// ...

@Injectable()
export class OpportunityRepository extends CrmEntityRepository<Opportunity> {
  readonly table = opportunities;

  protected override readonly behaviors: BehaviorConfig = {
    timestamps: true, softDelete: true, userTracking: false,
  };

  // From `config: { CrmEntity: { entityType: opportunity } }` in entity YAML
  protected override readonly patternConfig = {
    entityType: 'opportunity',
  } as const;

  constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
}
```

The pattern's base class declares `protected readonly patternConfig: TConfig` (typed via `z.infer<typeof CrmEntityConfigSchema>`) and reads `this.patternConfig` directly — no static-property indirection, no `this.constructor` cast. The instance shape is identical to how `behaviors: BehaviorConfig` already works (`templates/entity/new/clean-lite-ps/repository.ejs.t:27–31`).

---

## 7. Phase 1 Files

| File | Action | Purpose |
|------|--------|---------|
| `src/patterns/pattern-definition.ts` | create | `PatternDefinition` type + `definePattern()` |
| `src/patterns/registry.ts` | create | Library + app registries + `loadAppPatterns()` |
| `src/patterns/validate-composition.ts` | create | Column/config conflict detection |
| `src/patterns/index.ts` | create | Barrel export |
| `src/patterns/library/base.pattern.ts` | create | `BasePattern` |
| `src/patterns/library/synced.pattern.ts` | create | `SyncedPattern` |
| `src/patterns/library/activity.pattern.ts` | create | `ActivityPattern` |
| `src/patterns/library/knowledge.pattern.ts` | create | `KnowledgePattern` |
| `src/patterns/library/metadata.pattern.ts` | create | `MetadataPattern` |
| `src/schema/entity-definition.schema.ts` | modify | DELETE `family:`, ADD `pattern:`/`patterns:`/`config:` |
| `src/schema/pipelines-config.schema.ts` | modify | ADD `PatternsConfigSchema` |
| `src/config/config-loader.ts` | modify | ADD `patterns?: string[]` to `ProjectConfig` |
| `src/parser/load-entities.ts` | modify | Drop `family` mapping; add `pattern`/`patterns`/`patternConfig` |
| `src/analyzer/types.ts` | modify | Delete `EntityFamily` and `family?` field; add `pattern?`, `patterns?`, `patternConfig?` |
| `src/analyzer/serialize-graph.ts` | modify | Serialize `pattern`/`patterns` instead of `family` |
| `src/index.ts` | modify | Wire `validatePatternComposition()` into `analyzeDomain()` |
| `src/cli/commands/entity.ts` | modify | Rename summary column FAMILY → PATTERN; rename `--family` filter → `--pattern` |
| `src/cli/shared/init-scaffold.ts` | modify | Update YAML scaffold comment from `family:` to `pattern:` |
| `templates/entity/new/prompt.js` | modify | Delete dead `FAMILY_REPOSITORY_MAP`/`FAMILY_SERVICE_MAP` block |
| `templates/entity/new/clean-lite-ps/prompt-extension.js` | modify | Replace `FAMILY_MAP` with pattern-registry lookup |
| `templates/entity/new/clean-lite-ps/repository.ejs.t` | modify | Emit instance `patternConfig` when pattern has non-empty config |
| `templates/entity/new/clean-lite-ps/service.ejs.t` | modify | Same |
| Test fixtures: `test/fixtures/contact-v2.yaml`, `demo-deal.yaml`, `test/smoke/fixtures/*.yaml`, `test/scaffold/contact-scaffold.yaml`, `examples/eav/*.yaml` | modify | `family: synced` → `pattern: Synced` |
| `src/__tests__/schema/schema-v2.test.ts` and clean-lite-ps tests | modify | Replace `family` references with `pattern` references |
| Docs: `docs/CONSUMER-SETUP.md`, `docs/GETTING-STARTED.md`, `README.md`, `.claude/skills/codegen/SKILL.md`, `ai-docs/specs/{a6,a15}-*.md`, `docs/specs/JOB-7.md` | modify | Update `family` → `pattern` references |

---

## 8. Stacking Order (Phase 1 PRs)

1. **`feat/patterns-adr`** — This spec + ADR-031 + ADR-005 supersedure header. Docs only.
2. **`feat/patterns-primitive`** — `definePattern()`, registry, `loadAppPatterns()`, library patterns. Unit tests. No schema/parser/template changes.
3. **`feat/patterns-schema`** — Delete `family:`, add `pattern:`/`patterns:`/`config:`. Update parser, types, serialize-graph, CLI, init-scaffold. Migrate fixtures + tests.
4. **`feat/patterns-validation`** — `validate-composition.ts`. Wire into `analyzeDomain()`. Unit tests.
5. **`feat/patterns-templates`** — Replace `FAMILY_MAP` with registry lookup. Delete dead `FAMILY_REPOSITORY_MAP` in `prompt.js`. Emit `patternConfig` in templates. Add `PatternsConfigSchema`.

Each PR is independently buildable, typechecks, and passes `just test-unit` + `just test-baseline`.

---

## 9. Out of Phase 1

- `EventPattern` (state machine) — Phase 2
- `ActorPattern` (identity / reference number) — Phase 3
- App-defined `CrmEntityPattern` consumer integration in dealbrain-v2 — Phase 2 (consumer-side work)
- Multi-depth `extends` chain resolution — deferred until a real consumer asks
- `eav_value_table: true` migration into a Pattern — orthogonal, future
- The `clean` (full Clean Architecture) backend pipeline — currently does not consume `family`; pattern integration here is additive Phase 3+ work and not required by Phase 1 deliverable

---

## References

- ADR-031 — App-Defined Patterns (binding decisions)
- ADR-005 — Entity Family Base Classes (superseded by ADR-031)
- RFC: `docs/RFC-app-defined-patterns.md`
- Behavior conflict precedent: `src/behaviors/index.ts:81–117`
- Existing `behaviors: BehaviorConfig` template emission: `templates/entity/new/clean-lite-ps/repository.ejs.t:27–31`
- Today's `FAMILY_MAP` (to be replaced): `templates/entity/new/clean-lite-ps/prompt-extension.js:14–83`
