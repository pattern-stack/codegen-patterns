# ADR-031 — App-Defined Patterns

**Status:** Accepted
**Date:** 2026-04-19
**Owner:** Doug
**Related:** ADR-005 (superseded), ADR-008 (Subsystem Architecture, mirrored shape), ADR-032 (Orchestration Patterns — extends this ADR with a second `pattern:` kind for DI registries + dispatch)
**RFC:** `docs/RFC-app-defined-patterns.md`
**Implementation spec:** `docs/specs/app-defined-patterns-implementation.md`

> **Vocabulary note (2026-05-30, ADR-0005):** This ADR predates the `sync`→`integration` rename (shipped in 0.11.0). Where the body references the `Synced` family / `SyncedEntityRepository` / `SyncedPattern` / `family: synced`, read `Integrated` / `IntegratedEntityRepository` / `IntegratedPattern` / `pattern: Integrated`. The pattern mechanism is unchanged — only the library-shipped family's name. See swe-brain `ADR-0005-rename-sync-to-integration` and the 0.11.0 CHANGELOG.

## Context

ADR-005 introduced **entity families** — a closed set of library-shipped base classes (`SyncedEntityRepository`, `ActivityEntityRepository`, `KnowledgeEntityRepository`, `MetadataEntityRepository`) that the codegen-emitted concrete repos extend via `family: synced` in entity YAML. Families work for the four library-defined cases but cannot be extended by consumers: when an app needs a domain abstraction that sits between the library's family bases and concrete entities (e.g. dealbrain-v2's `CrmEntityRepository<T>` bundling EAV dual-write + canonical field routing), they hand-write the base class and break out of the codegen contract.

The RFC (`docs/RFC-app-defined-patterns.md`) proposes **Patterns** as the consumer-extensible replacement: composable semantic archetypes that bundle columns + repository/service contributions + per-use config, and which can be defined by either the library or the consuming application. Two Phase-1 questions are left open by the RFC:

1. The exact shape `definePattern()` accepts — what properties, what composition rules, what conflict semantics.
2. The runtime metadata hand-off — how does codegen pass per-entity config (e.g. CrmEntity's `entityType: opportunity`) into the pattern's base class.

This ADR closes both, locks the consumer-facing surface, and identifies three drifts from the implementation spec discovered during the understand phase that must travel with this change.

## Decision

### 1. `definePattern()` — pure metadata record returned by an identity function

```typescript
// src/patterns/pattern-definition.ts

import type { ZodSchema } from "zod";

export interface PatternColumnContribution {
  name: string;          // snake_case column name
  type: string;          // drizzle column type string (e.g. "varchar(255)")
}

export interface PatternDefinition<TConfig = unknown> {
  /** Unique name used in YAML: pattern: Synced */
  name: string;

  /** Built-in patterns this extends, by name. Phase 1 supports a single chain depth. */
  extends?: string[];

  /** Constructor name codegen emits in the `extends` clause. String — not the class itself. */
  repositoryClass?: string;
  serviceClass?: string;

  /**
   * Fully-qualified TS path-alias the consumer's tsconfig understands.
   * Library patterns use the consumer-installed runtime base class path
   * (e.g. "@shared/base-classes/synced-entity-repository").
   * App patterns use whatever alias the consumer's tsconfig resolves.
   */
  repositoryImport?: string;
  serviceImport?: string;

  /** Method signatures the pattern's base classes provide — emitted as comments in the generated repo/service. */
  repositoryInheritedMethods?: string[];
  serviceInheritedMethods?: string[];

  /** Columns this pattern adds to the entity table. Used by composition conflict detection. */
  columns?: PatternColumnContribution[];

  /** Behaviors this pattern implicitly enables. Entity YAML need not re-declare. */
  impliedBehaviors?: string[];

  /** Zod schema for the per-entity `config:` block, validated at parse time. */
  configSchema?: ZodSchema<TConfig>;

  /** One-line description for codegen help output. */
  description?: string;
}

export function definePattern<TConfig = unknown>(
  def: PatternDefinition<TConfig>,
): PatternDefinition<TConfig> {
  return def;
}
```

`definePattern` is an identity function. The file containing it is the registration artifact: codegen scans the configured pattern-file glob, dynamically `import()`s each file, and collects exports whose values pass an `isPatternDefinition` shape check. The class constructors referenced by `repositoryClass` / `serviceClass` are **never imported by codegen** — only their names and import paths are. This keeps the codegen pipeline free of TS class-evaluation costs and avoids `reflect-metadata` requirements.

At least one of `columns`, `repositoryClass`, or `serviceClass` must be present. A pattern that contributes nothing is a definition error.

### 2. YAML surface — `pattern:` / `patterns:` / `config:`

The `EntityConfigSchema` gains three fields. The legacy `family:` enum is **deleted** in the same change (per CLAUDE.md "no backwards compatibility until users" — no alias, no deprecation window, no console.warn shim). Every entity YAML migrates from `family: <name>` to `pattern: <Name>` in one sweep.

```yaml
# Single pattern (most common)
entity:
  name: opportunity
  pattern: Synced

# Multi-pattern composition
entity:
  name: deal
  patterns: [CrmEntity, Event]
  config:
    CrmEntity: { entityType: opportunity }
    Event:
      states: { qualifying: [developing, closed_lost], ... }
      initial_state: qualifying
```

Constraints (enforced by `EntityConfigSchema.refine`):
- `pattern` and `patterns` are mutually exclusive.
- The `config:` block is keyed by pattern name; each value is validated against that pattern's `configSchema` at parse time.

### 3. Composition rules

| Conflict | Mode | Resolution |
|---|---|---|
| Two patterns contribute the same column name | Generation-time hard error | Stop with a message naming both contributors |
| Pattern column conflicts with entity-declared field | Generation-time hard error | Same |
| Pattern column conflicts with a behavior field | Generation-time hard error | Same |
| Two patterns contribute methods with the same name | TypeScript compilation error at the consumer | App resolves in their own concrete class — composition errors that the type system already catches do not need a duplicate codegen check |
| Two patterns require the same implied behavior | Silent dedup | No error |
| Pattern referenced in YAML is not in the registry | Generation-time hard error | Stop with a message pointing at `codegen.config.yaml patterns:` |
| `config` block contains a key for an unused pattern | Generation-time warning | Continue |

Validation lives in `src/patterns/validate-composition.ts` and runs in `analyzeDomain()` after `resolveReferences()`. The shape mirrors `src/behaviors/index.ts:81–117` (`validateBehaviors`): a single pass, returning `{valid, errors, warnings}`.

### 4. Per-entity metadata hand-off — instance `patternConfig`

Patterns frequently need entity-specific metadata at runtime (CrmEntity's `entityType` chooses the EAV namespace; Event's `initial_state` seeds new rows). Codegen emits the validated YAML config as an **instance** `protected override readonly` property on the generated concrete repo (and, when the pattern has a service, on the generated service):

```typescript
@Injectable()
export class OpportunityRepository extends SyncedEntityRepository<Opportunity> {
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

The pattern's base class declares `protected readonly patternConfig: TConfig` (typed by the pattern's `configSchema` inference) and reads `this.patternConfig` generically. No reflection. No static-property indirection. Identical to how `BehaviorConfig` is already handed off.

When a pattern has no `configSchema` (e.g. `SyncedPattern`), no `patternConfig` property is emitted.

### 5. Pattern discovery — explicit glob in `codegen.config.yaml`

```yaml
# codegen.config.yaml
patterns:
  - src/patterns/*.pattern.ts        # default if `patterns:` is absent
  - vendor/internal-patterns/*.pattern.ts
```

Library-shipped patterns (`SyncedPattern`, `ActivityPattern`, etc.) are pre-registered by the codegen package itself — consumers do not list them. Any path in the consumer's `patterns:` block is glob-expanded relative to the project root and dynamically imported. Failed imports surface as a startup warning naming the file and the import error; codegen continues so unrelated entities still generate.

The Hygen subprocess (`templates/entity/new/prompt.js`) re-loads the registry independently using the same glob, since it has no shared memory with the CLI process. Both sides do deterministic side-effect-free reads of the same files; the duplication is one extra dynamic import per generation and is acceptable.

**Pattern-kind routing (ADR-032 Phase 3-1).** The loader now branches on the loaded value's `kind` field. Domain patterns (default, no `kind` or `kind: 'domain'`) land in `APP_PATTERNS`; orchestration patterns (`kind: 'orchestration'`) land in the disjoint `ORCHESTRATION_APP_PATTERNS` map and are looked up via `getOrchestrationPattern()` instead of `getPattern()`. The two maps are name-disjoint at load time — registering the same `name` across kinds is a project-level error caught by `validateOrchestrationProject` (`pattern_name_collision`). Same-kind name duplicates within either map are also load-time errors via `LoadAppPatternsResult.errors` (the previous silent-overwrite behaviour was wrong by the architectural-correctness rule).

## Drifts From the Implementation Spec

The 755-line implementation spec (`docs/specs/app-defined-patterns-implementation.md`, dated 2026-04-18) was drafted before the understand phase examined the existing code in depth. Three of its proposals contradict either the existing codebase or CLAUDE.md and are explicitly overridden here. The spec is being updated in the same commit as this ADR (per CLAUDE.md "specs are living documentation").

### Drift 1 — Static vs instance `patternConfig`

**Spec proposed (§6):** `static readonly patternConfig = { entityType: 'opportunity' } as const;` on the generated concrete class. Pattern base class reads `this.constructor.patternConfig`.

**ADR resolves:** Instance `protected override readonly patternConfig = {...} as const;` matching the existing `behaviors: BehaviorConfig` convention in `templates/entity/new/clean-lite-ps/repository.ejs.t:27–31`.

**Why:** The static-property idiom is a port of the Python `class Pattern: ...` inner-class pattern (`pattern_stack/atoms/patterns/base.py:77–110`). TypeScript already has a working answer for "per-entity config the base class reads at runtime" and that answer lives in this codebase already as `behaviors: BehaviorConfig`. Reusing the existing convention keeps the generated code uniform and avoids the `this.constructor as typeof X` cast that statics would require.

### Drift 2 — Import-path shape

**Spec proposed (§1):** `importPath: "patterns/crm-entity.pattern"` — a relative path, prefixed at template time with `@/`.

**ADR resolves:** Pattern definitions carry a fully-qualified TS path-alias (`repositoryImport: "@shared/base-classes/synced-entity-repository"`). App-defined patterns use whatever alias the consumer's tsconfig resolves (e.g. `@/patterns/crm-entity.pattern`).

**Why:** Today's `FAMILY_MAP` already emits path-aliases (`templates/entity/new/clean-lite-ps/prompt-extension.js:18,32,46,60,74`). Forcing relative paths would require codegen to know the consumer's source root layout to construct the right `../../` chain — which it does not, reliably. Path-aliases delegate that question to the consumer's tsconfig, which is the right layer.

### Drift 3 — Discovery surface

**Spec proposed (§3):** Per-file enumeration in `codegen.config.yaml patterns:` with optional glob support.

**ADR resolves:** Glob entries with a sensible default (`src/patterns/*.pattern.ts` is implicitly searched if the `patterns:` key is absent).

**Why:** Matches how `paths.entities` already declares a directory (not a per-file list) and how `paths.relationships` works. Forcing per-file enumeration would mean every new pattern file requires a config edit, which is friction the existing codebase has explicitly avoided for its other YAML-discovered surfaces.

## Consequences

### Positive

- **App authors gain a first-class extension seam.** dealbrain-v2's `CrmEntityRepository<T>` becomes `definePattern({ name: 'CrmEntity', extends: ['Synced'], … })` and stops being a hand-edit-after-regen liability.
- **The library's four families collapse into the same shape they describe.** No more duality between "library-only families" and "anything else." `SyncedPattern` is the canonical example app authors learn from.
- **Composition is explicit and validated.** Column conflicts surface at codegen time, not at migration time; pattern-config shape errors surface at parse time, not at request time.
- **CLAUDE.md's "delete don't deprecate" rule is honoured.** No `family:` alias means future agents reading the schema see exactly one way to declare a pattern, with no "is this still supported?" question.
- **The `EntityFamily` type bug is incidentally fixed.** Today's `src/analyzer/types.ts:56` declares `EntityFamily = 'crm-synced' | 'activity' | 'knowledge' | 'metadata'` (note: `crm-synced` not `synced`, missing `base`) but the schema accepts `'base' | 'synced' | 'activity' | 'knowledge' | 'metadata'`. The cast at `src/parser/load-entities.ts:69` papers over the divergence. Deleting both the type and the cast removes the bug.

### Negative

- **Two-process registry load.** Hygen runs as a subprocess (`src/cli/shared/hygen.ts:64`) so the pattern registry is built twice per `entity new` invocation — once by the CLI for validation, once by `prompt.js` for template rendering. Cost is one dynamic import per pattern file per process, both side-effect-free.
- **Pattern files are TypeScript, not YAML.** App authors who only write YAML today now need to write a TS file with a single `export const FooPattern = definePattern({...})` to register a new pattern. The line count is small (~10 lines for a contribution-only pattern, ~40 with config schema) but the surface widens.
- **The `extends` chain is single-depth in Phase 1.** A pattern can `extends: ['Synced']` but not yet `extends: ['CrmEntity']` where `CrmEntity` itself extends `Synced`. Multi-depth inheritance resolution is deferred until a real consumer asks for it.
- **No backwards compat means consumers regen.** Every entity YAML in every consumer project that uses `family:` must be hand-edited to `pattern:` in one pass. Acceptable per CLAUDE.md (no users yet).

### Neutral

- The four library-shipped runtime base classes (`runtime/base-classes/{synced,activity,knowledge,metadata}-entity-{repository,service}.ts`) are untouched. They are referenced by string name from the new `PatternDefinition` records.
- The `clean` (full Clean Architecture) backend template pipeline does not consume `family` today and gains no pattern-derived behavior. Patterns are wired through the `clean-lite-ps` pipeline only in Phase 1; extending to `clean` would be an additive Phase 3+ change.

## Alternatives Considered

### Alternative 1 — Keep `family:` as silent alias

Per the original implementation spec §8, accept both `family: synced` and `pattern: Synced` for two minor versions, with a console.warn after the first.

**Rejected because:** CLAUDE.md is explicit that this project has no external users and backwards-compat shims are anti-correctness. The cost of "delete and rewrite all YAML" is one find-and-replace across <50 fixture files; the cost of carrying an alias is shape ambiguity in every reader of the schema for two release cycles.

### Alternative 2 — Patterns as TS classes with decorators

`@Pattern({ name: 'Synced', columns: [...] }) class SyncedEntityRepository {...}` instead of a separate `definePattern()` metadata file.

**Rejected because:** Decorators require `reflect-metadata` (a peer-dep we already optional-flag) and force codegen to evaluate the full TS class hierarchy at registry-build time — slow, and breaks the "Hygen subprocess" model where the registry must rebuild without bringing the consumer's full module graph into memory.

### Alternative 3 — Inner-class config (Pattern Stack Python parity)

Mirror Pattern Stack's `class Pattern: states = {...}` literally — declare per-entity config as an inner class on the consumer's repo.

**Rejected because:** TypeScript inner classes are awkward (no real "nested class" syntax — would have to be a type-merged namespace), and the YAML `config:` block + Zod schema gives the same expressive power with a cleaner authoring surface that doesn't require touching TS for trivial config.

### Alternative 4 — Static `patternConfig` (per spec §6)

Discussed above as Drift 1. The argument for static was Python-parity; the argument against is in-codebase precedent.

## References

- ADR-005 — Entity Family Base Classes (superseded by this ADR)
- ADR-008 — Subsystem Architecture: Protocol → Backend → Factory (mirrored shape: registry + factory + composition)
- RFC: `docs/RFC-app-defined-patterns.md` — proposal and rationale
- Implementation spec: `docs/specs/app-defined-patterns-implementation.md` — file-by-file change plan (updated in same commit as this ADR)
- Behavior conflict precedent: `src/behaviors/index.ts:81–117`
- Existing `behaviors: BehaviorConfig` template emission: `templates/entity/new/clean-lite-ps/repository.ejs.t:27–31`
- Today's `FAMILY_MAP`: `templates/entity/new/clean-lite-ps/prompt-extension.js:14–83`
