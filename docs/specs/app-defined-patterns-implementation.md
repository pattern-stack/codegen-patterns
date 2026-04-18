# App-Defined Patterns — Implementation Spec

**RFC:** `docs/RFC-app-defined-patterns.md`
**Status:** Draft
**Date:** 2026-04-18
**Scope:** codegen-patterns library changes + first consumer integration (dealbrain-v2)

---

## 1. `definePattern()` API

### Resolved: Returns a `PatternDefinition` metadata record, not a class

The Python analogue is the `class Pattern:` inner class (base.py:77–110), which is a pure metadata carrier on the SQLAlchemy model. In TS, the hand-written base classes (`CrmEntityRepository<T>`) carry the runtime logic; `definePattern()` carries the codegen-time metadata the generator needs to wire inheritance, validate config, and detect conflicts.

```typescript
// src/patterns/pattern-definition.ts  (NEW — library)

import { z, type ZodSchema } from "zod";

export type PatternScope = "repository" | "service" | "entity" | "all";

export interface PatternColumnContribution {
  name: string;          // snake_case column name
  source: "pattern";     // distinguishes from entity-field contributions
  type: string;          // drizzle type string for conflict messages
}

export interface PatternDefinition<TConfig = unknown> {
  /** Unique name used in YAML: pattern: CrmEntity */
  name: string;

  /**
   * Built-in patterns this extends (resolved to their PatternDefinitions).
   * At most one chain depth in Phase 1.
   */
  extends?: string[];

  /**
   * Constructors for the base classes this pattern ships.
   * Codegen uses these names to emit the `extends` clause.
   * Values are constructor names as strings (not the classes themselves —
   * patterns.ts files are not imported at codegen time, only their metadata is).
   */
  repositoryClass?: string;  // e.g. "CrmEntityRepository"
  serviceClass?: string;     // e.g. "CrmEntityService"

  /** Import path for repositoryClass/serviceClass, relative to consumer src root */
  importPath: string;        // e.g. "patterns/crm-entity.pattern"

  /**
   * Columns this pattern contributes to the entity table.
   * Used by the conflict-detection pass. Mirrors BehaviorDefinition.fields
   * in src/behaviors/types.ts.
   */
  columns: PatternColumnContribution[];

  /**
   * Behaviors implicitly enabled by this pattern.
   * Entity YAML need not re-declare these.
   */
  impliedBehaviors?: string[];

  /**
   * Zod schema for the per-entity config block.
   * Validated at parse time against the entity's config: block.
   *
   * Mirrors Python EventPattern reading Pattern.states from the inner class
   * (event.py:81–88) but surfaced through YAML config: instead.
   */
  configSchema?: ZodSchema<TConfig>;

  /** Human-readable description for codegen help output */
  description?: string;
}

/**
 * definePattern — register a pattern's metadata with the generator.
 *
 * This function is called at the bottom of every *.pattern.ts file.
 * At codegen time, the manifest loader imports the file and collects
 * the returned PatternDefinition. The TS base classes in the same file
 * are NOT imported — only the metadata object is consumed by codegen.
 *
 * @example
 * export const CrmEntityPattern = definePattern({
 *   name: "CrmEntity",
 *   extends: ["Synced"],
 *   repositoryClass: "CrmEntityRepository",
 *   serviceClass: "CrmEntityService",
 *   importPath: "patterns/crm-entity.pattern",
 *   columns: [],                          // inherits Synced columns
 *   impliedBehaviors: ["external_id_tracking"],
 *   configSchema: z.object({
 *     entityType: z.enum(["opportunity", "account", "contact"]),
 *   }),
 * });
 */
export function definePattern<TConfig = unknown>(
  def: PatternDefinition<TConfig>
): PatternDefinition<TConfig> {
  return def;   // identity — caller's file IS the registration artifact
}
```

The generator loads pattern files via dynamic `import()` at codegen time, reads the exported `PatternDefinition` objects, and never touches the class constructors. This avoids needing to compile or evaluate the full TS class hierarchy during generation.

**Why not a class decorator or static property?** Both require the generator to instantiate or import the class. Dynamic import of a module that only exports a plain object is safe with `tsx` or `ts-node --transpile-only`. Decorators add a runtime dependency on `reflect-metadata`.

---

## 2. YAML Schema Extensions

### Current state (`src/schema/entity-definition.schema.ts:422–453`)

```typescript
// EntityConfigSchema today
const EntityConfigSchema = z.object({
  name: ...,
  plural: ...,
  table: ...,
  folder_structure: ...,
  file_grouping: ...,
  behavior_strategy: ...,
  expose: ...,
  family: z.enum(["base", "synced", "activity", "knowledge", "metadata"]).optional(),
}).strict();
```

### Proposed schema additions

```typescript
// EntityConfigSchema — proposed changes
const EntityConfigSchema = z.object({
  name: ...,
  plural: ...,
  table: ...,
  folder_structure: ...,
  file_grouping: ...,
  behavior_strategy: ...,
  expose: ...,

  // DEPRECATED: family → pattern alias. Emits console.warn at parse time.
  // Accepts the original 5 values + any string (for app-defined families used before migration).
  family: z.string().optional(),

  // NEW: single pattern name (string, resolved from registry at codegen time)
  pattern: z.string().optional(),

  // NEW: multi-pattern composition
  patterns: z.array(z.string()).optional(),

  // NEW: per-pattern config block (key = pattern name, value = opaque record
  // validated against that pattern's configSchema at parse time)
  config: z.record(z.string(), z.unknown()).optional(),
})
// Constraint: family, pattern, patterns are mutually exclusive
.refine(
  (d) => [d.family, d.pattern, d.patterns].filter(Boolean).length <= 1,
  { message: "Only one of 'family', 'pattern', or 'patterns' may be set" }
)
.strict();
```

### `ParsedEntity` additions (`src/analyzer/types.ts:87–100`)

```typescript
export interface ParsedEntity {
  name: string;
  plural: string;
  table: string;
  family?: EntityFamily;         // kept for backward compat
  pattern?: string;              // resolved single pattern name
  patterns?: string[];           // resolved multi-pattern names
  patternConfig?: Record<string, unknown>;  // per-pattern config, pre-validated
  folderStructure: "nested" | "flat";
  fields: Map<string, ParsedField>;
  relationships: Map<string, ParsedRelationship>;
  behaviors: string[];
  queries?: ParsedQuery[];
  sync?: ParsedSync;
  events?: ParsedEvent[];
  sourcePath: string;
}
```

### `transformToEntity()` change (`src/parser/load-entities.ts:48–71`)

Add after `family` line:

```typescript
// Normalize: family → pattern alias (with deprecation warning)
if (definition.entity.family && !definition.entity.pattern) {
  const BUILTIN_FAMILY_TO_PATTERN: Record<string, string> = {
    base:      "Base",
    synced:    "Synced",
    activity:  "Activity",
    knowledge: "Knowledge",
    metadata:  "Metadata",
  };
  const resolved = BUILTIN_FAMILY_TO_PATTERN[definition.entity.family];
  if (resolved) {
    console.warn(
      `[codegen] DEPRECATED: entity '${definition.entity.name}' uses 'family: ${definition.entity.family}'. ` +
      `Use 'pattern: ${resolved}' instead. 'family' will be removed in v1.0.`
    );
  }
  entity.pattern = resolved ?? definition.entity.family;
}
if (definition.entity.pattern) entity.pattern = definition.entity.pattern;
if (definition.entity.patterns) entity.patterns = definition.entity.patterns;
if (definition.entity.config) entity.patternConfig = definition.entity.config;
```

### Entity YAML examples

**Before (current):**
```yaml
entity:
  name: opportunity
  plural: opportunities
  table: opportunities
  family: synced
behaviors:
  - timestamps
  - soft_delete
```

**After (single pattern):**
```yaml
entity:
  name: opportunity
  plural: opportunities
  table: opportunities
  pattern: CrmEntity
  config:
    CrmEntity:
      entityType: opportunity
behaviors:
  - timestamps
  - soft_delete
```

**Multi-pattern composition:**
```yaml
entity:
  name: deal
  plural: deals
  table: deals
  patterns: [CrmEntity, Event]
  config:
    CrmEntity:
      entityType: opportunity
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

### Resolved: Explicit manifest in `codegen.config.yaml`

**Reasoning:** App-defined patterns are TypeScript source files. To extract their `PatternDefinition` metadata at codegen time, the generator must import them. This requires either:

(a) A compilation step (slow, fragile, adds a build dependency to the codegen pipeline), or
(b) `tsx`/`ts-node --transpile-only` dynamic import (works, but only if files are pointed at explicitly — scanning a directory gives paths but no guarantee the files export the right shape without loading them all).

An explicit manifest is one config line, loads zero ambiguity, and matches how the existing `codegen.config.yaml` already declares `paths.entities` rather than scanning for YAML files itself.

### `codegen.config.yaml` additions

```yaml
# codegen.config.yaml
paths:
  entities: entities/
  backend_src: apps/backend/src/

# NEW: explicit pattern manifest
patterns:
  - src/patterns/crm-entity.pattern.ts
  - src/patterns/eav.pattern.ts
  # glob syntax also supported, resolved relative to project root:
  # - src/patterns/*.pattern.ts
```

### Schema additions (`src/schema/pipelines-config.schema.ts`)

```typescript
// Add to the top-level config schema (alongside pipelines, generate)
export const PatternsConfigSchema = z.array(z.string()).optional().default([]);
export type PatternsConfig = z.infer<typeof PatternsConfigSchema>;
```

The `ProjectConfig` interface in `src/config/config-loader.ts:27–31` gains:

```typescript
export interface ProjectConfig {
  pipelines?: PipelinesConfig;
  generate?: GenerateConfig;
  patterns?: string[];   // NEW: pattern manifest paths
  [key: string]: unknown;
}
```

### Pattern registry (`src/patterns/registry.ts` — NEW)

```typescript
// src/patterns/registry.ts  (NEW — library)

import { glob } from "glob";
import path from "node:path";
import type { PatternDefinition } from "./pattern-definition.js";

// Library-shipped built-in patterns (shipped with codegen-patterns runtime)
const LIBRARY_PATTERNS: Map<string, PatternDefinition> = new Map();

// App-defined patterns loaded at codegen time
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

/**
 * Load app-defined patterns from the manifest paths in codegen.config.yaml.
 * Called once per codegen invocation, before entity parsing begins.
 *
 * Each path is resolved relative to `cwd`, glob-expanded, then dynamically
 * imported. Exports named `*Pattern` (matching /Pattern$/) are collected.
 */
export async function loadAppPatterns(
  manifestPaths: string[],
  cwd: string
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
    typeof val === "object" &&
    val !== null &&
    "name" in val &&
    "importPath" in val
  );
}
```

### Integration point in the CLI

In `src/cli/commands/entity.ts`, before invoking Hygen, call:

```typescript
const patternManifest = context.config?.patterns ?? [];
const { loaded, errors } = await loadAppPatterns(patternManifest, context.cwd);
if (errors.length) { /* printWarning each */ }
```

---

## 4. Composition + Conflict Resolution

### Conflict classes

| Conflict type | Mode | Resolution |
|---|---|---|
| Two patterns contribute the same column name | Generation-time hard error | Stop with message |
| Pattern column conflicts with entity-declared field | Generation-time hard error | Stop with message |
| Pattern column conflicts with a behavior field | Generation-time hard error | Stop with message |
| Two patterns contribute methods with the same name | TypeScript compilation error | Consumer resolves in their overriding class |
| Two patterns require the same implied behavior | Silent dedup | No error — idempotent |

### Validation pass (`src/patterns/validate-composition.ts` — NEW)

Mirrors the behavior conflict check in `src/behaviors/index.ts:82–117`.

```typescript
// src/patterns/validate-composition.ts  (NEW)

import type { ParsedEntity } from "../analyzer/types.js";
import { getPattern } from "./registry.js";
import { resolveBehaviorFields } from "../behaviors/index.js";

export interface CompositionError {
  entity: string;
  message: string;
}

export function validatePatternComposition(entity: ParsedEntity): CompositionError[] {
  const errors: CompositionError[] = [];
  const patternNames = entity.patterns ?? (entity.pattern ? [entity.pattern] : []);

  if (patternNames.length === 0) return errors;

  // Collect all column names from: entity fields + behavior fields + pattern columns
  const columnSources = new Map<string, string>(); // columnName → source description

  for (const [name] of entity.fields) {
    columnSources.set(name, `entity field`);
  }

  const behaviorFields = resolveBehaviorFields(entity.behaviors);
  for (const bf of behaviorFields) {
    if (columnSources.has(bf.name)) {
      errors.push({
        entity: entity.name,
        message: `Behavior field '${bf.name}' conflicts with entity field '${bf.name}'`,
      });
    }
    columnSources.set(bf.name, `behavior field`);
  }

  for (const patternName of patternNames) {
    const def = getPattern(patternName);
    if (!def) {
      errors.push({
        entity: entity.name,
        message: `Unknown pattern '${patternName}'. Is it registered in codegen.config.yaml patterns:?`,
      });
      continue;
    }

    // Validate per-pattern config against configSchema
    if (def.configSchema) {
      const rawConfig = entity.patternConfig?.[patternName];
      const result = def.configSchema.safeParse(rawConfig ?? {});
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
        errors.push({
          entity: entity.name,
          message: `Pattern '${patternName}' config invalid: ${issues}`,
        });
      }
    }

    for (const col of def.columns) {
      if (columnSources.has(col.name)) {
        errors.push({
          entity: entity.name,
          message:
            `Pattern '${patternName}' contributes column '${col.name}' which conflicts ` +
            `with ${columnSources.get(col.name)}. Rename one.`,
        });
      }
      columnSources.set(col.name, `pattern '${patternName}'`);
    }
  }

  return errors;
}
```

This validation pass runs in `analyzeDomain()` (`src/index.ts`) after `resolveReferences()`, before Hygen invocation.

---

## 5. Library-Shipped Patterns Migration

### Directory layout

```
src/
  patterns/
    library/
      base.pattern.ts          # BasePattern (id, timestamps, lifecycle events)
      synced.pattern.ts        # SyncedPattern — port of synced family base classes
      activity.pattern.ts      # ActivityPattern — port of activity family
      knowledge.pattern.ts     # KnowledgePattern — port of knowledge family
      metadata.pattern.ts      # MetadataPattern — port of metadata family
      event.pattern.ts         # EventPattern — port from pattern_stack EventPattern
      actor.pattern.ts         # ActorPattern — port from pattern_stack ActorPattern
    pattern-definition.ts      # PatternDefinition type + definePattern()
    registry.ts                # Pattern registry + loadAppPatterns()
    validate-composition.ts    # Conflict detection pass
    index.ts                   # Barrel
```

### What moves where

| Today | With Patterns |
|---|---|
| `SyncedEntityRepository` (runtime base class, consumer-copied) | Stays as runtime base class; `synced.pattern.ts` wraps it in a `PatternDefinition` with `repositoryClass: "SyncedEntityRepository"` |
| `family: synced` in YAML | Resolved to `pattern: Synced` internally; `SyncedPattern` `PatternDefinition` points at same base class |
| No codegen awareness of what `family: synced` adds | `SyncedPattern.columns` lists `external_id`, `provider`, `provider_metadata`; conflict detection now works |

**Nothing in the runtime moves.** The consumer-copied base classes (the `shared/base-classes/` tree in dealbrain-v2) are unchanged. `PatternDefinition` objects are pure metadata — they reference class names by string, not by import.

### `synced.pattern.ts` — representative example

```typescript
// src/patterns/library/synced.pattern.ts

import { definePattern } from "../pattern-definition.js";

export const SyncedPattern = definePattern({
  name: "Synced",
  extends: ["Base"],
  repositoryClass: "SyncedEntityRepository",
  serviceClass: "SyncedEntityService",
  importPath: "@shared/base-classes/synced-entity-repository",
  columns: [
    { name: "external_id",       source: "pattern", type: "varchar(255)" },
    { name: "provider",          source: "pattern", type: "varchar(100)" },
    { name: "provider_metadata", source: "pattern", type: "jsonb" },
  ],
  impliedBehaviors: ["external_id_tracking"],
  description: "Adds external CRM/system sync columns and syncUpsert methods",
});
```

### `event.pattern.ts` — state machine config schema

```typescript
// src/patterns/library/event.pattern.ts
// Ported from pattern_stack/atoms/patterns/event.py

import { z } from "zod";
import { definePattern } from "../pattern-definition.js";

const EventPatternConfigSchema = z.object({
  states: z.record(z.string(), z.array(z.string())),
  initial_state: z.string(),
  reference_prefix: z.string().optional(),
  emit_state_transitions: z.boolean().optional().default(true),
});

export const EventPattern = definePattern({
  name: "Event",
  extends: ["Base"],
  repositoryClass: "EventEntityRepository",
  serviceClass: "EventEntityService",
  importPath: "@shared/base-classes/event-entity-repository",
  columns: [
    { name: "state",      source: "pattern", type: "varchar(50)" },
    { name: "deleted_at", source: "pattern", type: "timestamp" },
  ],
  configSchema: EventPatternConfigSchema,
  description: "Adds state machine, transition hooks, reference numbers",
});
```

The config schema mirrors the Python `Pattern` inner class fields (`event.py:80–88`): `states`, `initial_state`, `reference_prefix`.

---

## 6. Generated Output Shape

### Before: `opportunity.repository.ts` (current, generated)

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
  // declarative queries...
}
```

### After: with `pattern: CrmEntity`

```typescript
// CHANGED: import path from pattern's importPath + repositoryClass
import { CrmEntityRepository } from '@/patterns/crm-entity.pattern';
// ...

@Injectable()
export class OpportunityRepository extends CrmEntityRepository<Opportunity> {
  readonly table = opportunities;

  // NEW: pattern config injected as a typed static property
  // (for the base class to read at runtime — mirrors Python Pattern inner class access)
  static readonly patternConfig = {
    entityType: "opportunity",    // from entity YAML config.CrmEntity.entityType
  } as const;

  protected override readonly behaviors: BehaviorConfig = {
    timestamps: true,
    softDelete: true,
    userTracking: false,
  };
  constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
  // declarative queries... (unchanged)
}
```

**Diff summary:**
- `extends` clause: `SyncedEntityRepository` → `CrmEntityRepository`
- Import: `@shared/base-classes/...` → `@/patterns/crm-entity.pattern`
- New static `patternConfig` property with validated YAML config values
- Everything else (behaviors, queries, constructor) is identical

The `patternConfig` static property is how the Python `Pattern` inner class idiom (base.py:77–88: `class Pattern: entity = ...`) is ported to TS. The base class accesses `this.constructor.patternConfig` at runtime to read entity-specific config without reflection.

---

## 7. Prototype Path

### Resolved: `SyncedPattern` first

**Reasoning:**

`SyncedPattern` is the smallest surface area that proves the full primitive:
- It has a direct family analogue (`family: synced`) — backward compat is immediately testable
- It has a real consumer waiting (dealbrain-v2 `opportunity/account/contact`) to validate the DX
- Its `PatternDefinition.columns` list is small (3 columns) — conflict detection is easy to verify
- It has no config schema, keeping the first prototype tight
- `CrmEntityPattern` in dealbrain-v2 extends it — so validating `SyncedPattern` also validates the consumer-extension path

`EventPattern` is higher semantic value but carries the state machine config schema, `initial_state` initialization logic, and transition hook surface — all of which require more generator template changes. Save for Phase 2.

**Prototype milestone definition:**

1. `src/patterns/pattern-definition.ts` — `definePattern()` function + `PatternDefinition` type
2. `src/patterns/registry.ts` — registry + `loadAppPatterns()`
3. `src/patterns/library/synced.pattern.ts` — `SyncedPattern` metadata
4. `src/schema/entity-definition.schema.ts` — add `pattern:` + `config:` keys; `family:` deprecation warning
5. `src/parser/load-entities.ts` — normalize `family → pattern`, populate `entity.pattern`
6. `src/patterns/validate-composition.ts` — conflict detection pass
7. Template change: `opportunity.repository.ts.ejs.t` — `extends` clause reads `pattern.repositoryClass` not `family`
8. `codegen.config.yaml` in dealbrain-v2: add `patterns: [src/patterns/crm-entity.pattern.ts]`
9. dealbrain-v2 `opportunity.yaml`: change `family: synced` → `pattern: CrmEntity`
10. Regenerate; verify `opportunity.repository.ts` extends `CrmEntityRepository`

---

## 8. Rollout + Backward Compatibility

### `family:` deprecation schedule

| Release | `family:` behavior |
|---|---|
| v0.x (current + next 2 minors) | Fully supported; silently resolves to equivalent `pattern:` name |
| v0.x+1 (introduces `pattern:`) | `family:` still works; console.warn printed at parse time |
| v1.0 | `family:` removed from schema; ZodError at parse time |

The warning fires in `transformToEntity()` (`src/parser/load-entities.ts`) — exactly where `family` is currently read (line 64). This is the only place `family` is consumed; no other changes needed for the deprecation path.

### The 5 built-in family → pattern name mapping

```
base      → Base
synced    → Synced
activity  → Activity
knowledge → Knowledge
metadata  → Metadata
```

This mapping lives as a constant in `load-entities.ts` (shown in Section 2 above). No schema change needed to emit the warning — the schema keeps accepting `family: string` with the `.optional()` validator.

### Feature-flag approach for early adoption

Add to `codegen.config.yaml`:

```yaml
generate:
  patterns: true   # opt-in during v0.x to enable pattern: key in entity YAML
```

When `generate.patterns` is false (default in v0.x), the parser accepts `pattern:` in YAML but emits a warning that it has no effect until the flag is on. This prevents silent failures in codebases that haven't opted in but accidentally write `pattern:`.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/patterns/pattern-definition.ts` | create | `PatternDefinition` type + `definePattern()` |
| `src/patterns/registry.ts` | create | Pattern registry + `loadAppPatterns()` |
| `src/patterns/validate-composition.ts` | create | Column/config conflict detection pass |
| `src/patterns/library/base.pattern.ts` | create | `BasePattern` metadata |
| `src/patterns/library/synced.pattern.ts` | create | `SyncedPattern` metadata (Phase 1 prototype) |
| `src/patterns/library/activity.pattern.ts` | create | `ActivityPattern` metadata (Phase 2) |
| `src/patterns/library/knowledge.pattern.ts` | create | `KnowledgePattern` metadata (Phase 2) |
| `src/patterns/library/metadata.pattern.ts` | create | `MetadataPattern` metadata (Phase 2) |
| `src/patterns/library/event.pattern.ts` | create | `EventPattern` metadata + config schema (Phase 2) |
| `src/patterns/library/actor.pattern.ts` | create | `ActorPattern` metadata (Phase 3) |
| `src/patterns/index.ts` | create | Barrel export |
| `src/schema/entity-definition.schema.ts` | modify | Add `pattern:`, `patterns:`, `config:` keys; `family:` deprecation |
| `src/schema/pipelines-config.schema.ts` | modify | Add `PatternsConfigSchema` |
| `src/config/config-loader.ts` | modify | Add `patterns?: string[]` to `ProjectConfig` |
| `src/parser/load-entities.ts` | modify | `transformToEntity()`: normalize family→pattern, populate new fields |
| `src/analyzer/types.ts` | modify | Add `pattern?`, `patterns?`, `patternConfig?` to `ParsedEntity` |
| `src/index.ts` | modify | Call `validatePatternComposition()` in `analyzeDomain()` |
| `src/cli/commands/entity.ts` | modify | Call `loadAppPatterns()` before Hygen invocation |
| `templates/clean-lite-ps/entity/new/repository.ejs.t` | modify | `extends` clause reads pattern class, not family |

---

## Open Questions — Resolved

All 6 RFC open questions are addressed above:

1. **Discovery** (Section 3): Explicit manifest in `codegen.config.yaml patterns:` key.
2. **Config surface** (Section 2 + 6): YAML `config:` block is the front door; Zod schema in `definePattern()` is the typed contract; generated static `patternConfig` is the runtime accessor.
3. **Repository vs Service vs Entity ownership** (Section 1): `PatternDefinition` has optional `repositoryClass`, `serviceClass`. Entity-owning patterns (future) would add `entityColumns` vs `columns`. Phase 1 patterns all contribute to repo+service only.
4. **Generated vs hand-written split** (Section 6): Generated concrete repo declares `static readonly patternConfig = { entityType: "opportunity" }`. Pattern base class reads `this.constructor.patternConfig` generically. No entity-specific code in the base class.
5. **Backward compat** (Section 8): `family:` stays as silent alias in v0.x, warning in v0.x+1, removed in v1.0.
6. **Pattern Stack parity** (Section 5): Phase 1 ports `states`/`initial_state`/`reference_prefix` config surface from `EventPattern` (event.py:80–88). Change tracking, broadcast, and activity monitoring are out of scope for Phase 1.

---

## References

- RFC: `docs/RFC-app-defined-patterns.md`
- Python `BasePattern` inner-class config idiom: `pattern_stack/atoms/patterns/base.py:77–110`
- Python `EventPattern` state config: `pattern_stack/atoms/patterns/event.py:80–88`
- Python `ReferenceNumberMixin`: `pattern_stack/atoms/patterns/mixins.py:22–80`
- Existing behavior registry pattern (model for conflict detection): `src/behaviors/index.ts:27–124`
- Existing entity schema to extend: `src/schema/entity-definition.schema.ts:422–453`
- Entity parser to modify: `src/parser/load-entities.ts:48–71`
- Current generated repo (before diff): `apps/backend/src/modules/opportunities/opportunity.repository.ts` (dealbrain-v2)
