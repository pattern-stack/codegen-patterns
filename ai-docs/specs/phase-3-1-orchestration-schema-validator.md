# Phase 3-1 — Orchestration Pattern Schema + Validator

**Status:** Spec ready for build
**Parent ADRs:** `docs/adrs/ADR-032-orchestration-patterns.md`, `docs/adrs/ADR-031-app-defined-patterns.md`
**Scope:** Type extension, discovery routing, project-level validator. **No emission.** Phase 3-2/3-3 own templates and runtime.

---

## 1. Goals

Extend the existing `PatternDefinition` surface and discovery pipeline to admit a second pattern `kind` — `"orchestration"` — and add a new validator (`validate-orchestration.ts`) that enforces the four ADR-032 composition rules to the extent that Phase 3-1 can statically check them. No artifact emission. The output of Phase 3-1 is: the validator returns structured `AnalysisIssue[]` from `analyzeDomain()` for orchestration-level conflicts the same way `validatePatternComposition` does for domain conflicts today.

---

## 2. File-by-file change list

### Modify

- `src/patterns/pattern-definition.ts`
  - Add `kind?: 'domain' | 'orchestration'` (default `'domain'`) to `PatternDefinition`.
  - Add `OrchestrationPatternDefinition` interface (registry shape per ADR-032).
  - Add narrowing helpers `isDomainPattern(def)` and `isOrchestrationPattern(def)`.
  - Add type alias `AnyPatternDefinition = PatternDefinition | OrchestrationPatternDefinition`.
  - Loosen `isPatternDefinition()` so orchestration shapes also pass — already passes today (only checks `name: string`); add a JSDoc note that the discriminator is enforced downstream.
- `src/patterns/registry.ts`
  - Split storage into `DOMAIN_PATTERNS` + `ORCHESTRATION_PATTERNS` (renamed from `LIBRARY_PATTERNS` + `APP_PATTERNS`? — see Section 4: keep library/app axis, add orchestration as a third map. Final pick: keep `LIBRARY_PATTERNS` + `APP_PATTERNS` for domain pattern storage; add a parallel `ORCHESTRATION_APP_PATTERNS`. Library never ships orchestration patterns in Phase 3-1).
  - Update `assertHasContribution()` to dispatch on `kind`. Orchestration contribution = registry has at least one entry.
  - Update `loadAppPatterns()` to route on `def.kind`: orchestration → `ORCHESTRATION_APP_PATTERNS`, otherwise → `APP_PATTERNS`.
  - Add `getOrchestrationPattern(name)`, `getAllOrchestrationPatterns()`, `getOrchestrationPatternNames()`.
  - Update `getPattern()` JSDoc — narrow it to domain only (orchestration consumers must use `getOrchestrationPattern`). Justification in Section 4.
  - Cross-kind name-collision detection lives in the validator, not the registry, to keep `loadAppPatterns()` non-throwing.
- `src/patterns/index.ts`
  - Export the new types: `OrchestrationPatternDefinition`, `AnyPatternDefinition`, `isDomainPattern`, `isOrchestrationPattern`.
  - Export new registry accessors: `getOrchestrationPattern`, `getAllOrchestrationPatterns`, `getOrchestrationPatternNames`.
  - Export new validator: `validateOrchestrationProject`.
- `src/index.ts`
  - Wire `validateOrchestrationProject` into `analyzeDomain` alongside `validatePatternProject`.
  - Append its issues to `allIssues`.

### Add

- `src/patterns/validate-orchestration.ts`
  - Project-level validator (`validateOrchestrationProject`).
  - Returns `AnalysisIssue[]` matching `validatePatternProject`'s shape.
- `src/__tests__/patterns/validate-orchestration.test.ts`
  - Mirrors `src/__tests__/patterns/validate-composition.test.ts` structure.
- `src/__tests__/patterns/fixtures/orchestration/` (new dir)
  - `valid-crm-ports.pattern.ts` — happy path (one registry, two entries, optional dispatcher).
  - `valid-co-keyed-crm.pattern.ts` — happy path with `coKeyedRegistries`.
  - `name-collision-with-domain.pattern.ts` — orchestration pattern named `Synced` (collides with library domain pattern).
  - `duplicate-entry-key.pattern.ts` — registry with two entries sharing the same `key`.
  - `malformed-entries.pattern.ts` — registry with empty entries array.

### NOT modified

- `templates/**` — Phase 3-2/3-3.
- `runtime/**` — orchestration emits to `src/orchestration/` in the consumer; runtime base classes unchanged.
- `src/cli/**` — validator integration is via `analyzeDomain`, not the CLI directly.
- `src/patterns/library/**` — no library-shipped orchestration patterns in Phase 3-1.

---

## 3. Type definitions (final TS — copy verbatim into `pattern-definition.ts`)

```ts
/**
 * Discriminator for the two pattern shapes. Default is "domain" to preserve
 * Phase 1 (ADR-031) behaviour — every existing PatternDefinition without a
 * `kind` field continues to register as a domain pattern.
 */
export type PatternKind = 'domain' | 'orchestration';

export interface PatternDefinition<TConfig = unknown> {
  name: string;
  /** ADR-032: defaults to "domain". Phase 3 adds "orchestration". */
  kind?: 'domain';

  // ... existing fields unchanged (extends, repositoryClass, serviceClass,
  //     repositoryImport, serviceImport, repositoryInheritedMethods,
  //     serviceInheritedMethods, columns, impliedBehaviors, configSchema,
  //     description) ...
}

/**
 * One registry's declarative shape. ADR-032 §"The Proposal".
 *
 * Phase 3-1 records this; Phase 3-2 codegen reads it to emit token files,
 * provider blocks, and dispatcher overload signatures. Phase 3-1 validates
 * only what is statically checkable from this record alone — see
 * `validate-orchestration.ts` for the rules and their deferral notes.
 */
export interface OrchestrationRegistrySpec {
  /**
   * Type alias the consumer's tsconfig resolves (e.g. "CrmAdapterDomain").
   * Phase 3-1 stores this string verbatim. Resolution that the path actually
   * imports a concrete TS enum is deferred to Phase 3-2 emission, where the
   * codegen process will need to read the consumer's source tree.
   */
  keyType: string;
  /** Same shape as keyType — the registry's value-type interface ref. */
  valueType: string;
  entries: ReadonlyArray<{
    /** Stable string key — must be unique within this registry. */
    key: string;
    /**
     * Concrete provider class name (NOT a DI token string). Codegen will
     * import this and use it as the constructor injectable.
     * Phase 3-1 records it; Phase 3-2 verifies it resolves.
     */
    provider: string;
  }>;
}

/**
 * Orchestration pattern — declarative DI registry + optional dispatcher
 * scaffold. ADR-032 §"The Proposal" + Decisions 1-8.
 *
 * Disjoint from `PatternDefinition` (domain): no columns, no
 * repository/service base class, no entity-level patternConfig. Composition
 * with domain patterns happens only at the DI layer in the consumer's
 * generated code, not in entity YAML.
 */
export interface OrchestrationPatternDefinition {
  name: string;
  kind: 'orchestration';
  /** Primary registry (always present). */
  registry: OrchestrationRegistrySpec;
  /**
   * Sibling registries that share the primary registry's key space.
   * ADR-032 Decision 2 — co-keyed groups are a first-class field.
   * Validator enforces matching `keyType` across the group.
   */
  coKeyedRegistries?: ReadonlyArray<OrchestrationRegistrySpec>;
  /** Optional dispatcher scaffold spec (ADR-032 Decision 4 + 5). */
  dispatcher?: {
    /** Class name to emit (e.g. "CrmPortsDispatcher"). */
    className: string;
    /**
     * Method name the consumer overrides in their subclass to fill the
     * assembly body (ADR-032 Decision 5).
     */
    assemblySlot: string;
  };
  /** One-line description for help output and error messages. */
  description?: string;
}

/** Union for callers that need to handle both shapes. */
export type AnyPatternDefinition =
  | PatternDefinition
  | OrchestrationPatternDefinition;

export function isOrchestrationPattern(
  def: AnyPatternDefinition,
): def is OrchestrationPatternDefinition {
  return (def as { kind?: PatternKind }).kind === 'orchestration';
}

export function isDomainPattern(
  def: AnyPatternDefinition,
): def is PatternDefinition {
  return !isOrchestrationPattern(def);
}
```

Note: `definePattern()` keeps its existing signature (returns `PatternDefinition<TConfig>` unchanged). Add a sibling identity function:

```ts
export function defineOrchestrationPattern(
  def: OrchestrationPatternDefinition,
): OrchestrationPatternDefinition {
  return def;
}
```

`isPatternDefinition()` stays loose (only checks `name: string`). The kind check happens in the loader.

---

## 4. Discovery loader change

**Decision: separate maps + separate accessors.**

Justification:
- `getPattern()` is called from `validatePatternComposition` and from template-loading sites that expect domain shape. Returning a possibly-orchestration value would force every caller to narrow, even though the answer is "no" for every legitimate caller. The existing 12+ callsites would each need an `isDomainPattern` check.
- A `kind` filter parameter on `getPattern(name, kind?)` works but obscures intent at every callsite — the reader must remember that omitting `kind` defaults to domain.
- Separate accessors (`getPattern` for domain, `getOrchestrationPattern` for orchestration) make the type system enforce the distinction with zero runtime cost. This matches ADR-032 Decision 8: "the surfaces are disjoint."

Storage:

```ts
// existing — unchanged in role but now domain-only by contract
const LIBRARY_PATTERNS: Map<string, PatternDefinition> = new Map();
const APP_PATTERNS: Map<string, PatternDefinition> = new Map();

// new
const ORCHESTRATION_APP_PATTERNS: Map<string, OrchestrationPatternDefinition> = new Map();
```

Loader (`loadAppPatterns`) routing:

```ts
for (const [key, val] of Object.entries(mod)) {
  if (!key.endsWith('Pattern')) continue;
  if (!isPatternDefinition(val)) continue;

  if (isOrchestrationPattern(val as AnyPatternDefinition)) {
    try {
      assertOrchestrationContribution(val);
      ORCHESTRATION_APP_PATTERNS.set(val.name, val);
      loaded.add(val.name);
    } catch (assertErr) {
      errors.push(`Orchestration pattern '${val.name}' in ${rel} is invalid: ${...}`);
    }
  } else {
    // existing domain branch — assertHasContribution + APP_PATTERNS.set
  }
}
```

`assertOrchestrationContribution(def)`: must have a `registry` with `keyType`, `valueType`, and at least one `entries[]` element. (Detailed entry validation — duplicate keys, etc. — runs in the validator, not the registry, to keep loader behaviour symmetrical with the domain side.)

New accessors (mirror existing API):
- `getOrchestrationPattern(name): OrchestrationPatternDefinition | undefined`
- `getOrchestrationPatternNames(): string[]` (sorted)
- `getAllOrchestrationPatterns(): OrchestrationPatternDefinition[]` (used by the project-level validator to iterate all orchestration defs in one place)

`_resetRegistryForTests()` clears `ORCHESTRATION_APP_PATTERNS` too. The `includeLibrary` option does not touch it because library doesn't ship orchestration patterns in Phase 3-1.

---

## 5. Validator pseudocode (`src/patterns/validate-orchestration.ts`)

Project-level only — orchestration patterns are not entity-attached, so there is no per-entity pass.

```ts
export interface OrchestrationProjectContext {
  /** All orchestration patterns currently registered. */
  orchestrationPatterns: ReadonlyArray<OrchestrationPatternDefinition>;
  /** All domain pattern names currently registered (library + app). */
  domainPatternNames: ReadonlyArray<string>;
}

export function validateOrchestrationProject(
  ctx: OrchestrationProjectContext,
): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];

  // --- Rule 1: orchestration <-> domain name collision (ADR-032 row 4) ---
  // Hard error — names live in one registry across kinds.
  const domainNameSet = new Set(ctx.domainPatternNames);
  for (const orch of ctx.orchestrationPatterns) {
    if (domainNameSet.has(orch.name)) {
      issues.push({
        severity: 'error',
        type: 'pattern_name_collision',
        entity: '<project>',
        message:
          `Orchestration pattern '${orch.name}' shares a name with a domain ` +
          `pattern. Pattern names are globally unique across kinds (ADR-032 §Composition rules).`,
      });
    }
  }

  // --- Rule 2: orchestration <-> orchestration name collision (ADR-032 row 1) ---
  // Storage already keys by name so a duplicate would have silently overwritten
  // during load. Phase 3-1 cannot detect this from the post-load map alone.
  // Decision: detect at LOAD TIME instead — see Section 4 amendment below.
  // (Rule still listed here for traceability; the actual issue is emitted by
  // the loader as an `errors[]` entry, surfaced via the existing
  // LoadAppPatternsResult.errors plumbing in the CLI.)

  // --- Rule 3: well-formed entries + key uniqueness within a registry ---
  for (const orch of ctx.orchestrationPatterns) {
    const allRegistries = [orch.registry, ...(orch.coKeyedRegistries ?? [])];

    for (const reg of allRegistries) {
      // 3a. entries[] non-empty (defensive — loader already checked primary).
      if (reg.entries.length === 0) {
        issues.push({
          severity: 'error',
          type: 'pattern_entries_empty',
          entity: '<project>',
          message:
            `Orchestration pattern '${orch.name}' declares a registry with ` +
            `no entries. Provide at least one { key, provider } pair.`,
        });
        continue;
      }

      // 3b. duplicate keys within this registry.
      const seen = new Set<string>();
      for (const entry of reg.entries) {
        if (!entry.key || typeof entry.key !== 'string') {
          issues.push({
            severity: 'error',
            type: 'pattern_entry_malformed',
            entity: '<project>',
            message:
              `Orchestration pattern '${orch.name}' has an entry with a ` +
              `missing or non-string 'key'.`,
          });
          continue;
        }
        if (!entry.provider || typeof entry.provider !== 'string') {
          issues.push({
            severity: 'error',
            type: 'pattern_entry_malformed',
            entity: '<project>',
            message:
              `Orchestration pattern '${orch.name}' entry '${entry.key}' has ` +
              `a missing or non-string 'provider'.`,
          });
          continue;
        }
        if (seen.has(entry.key)) {
          issues.push({
            severity: 'error',
            type: 'pattern_entry_key_duplicate',
            entity: '<project>',
            message:
              `Orchestration pattern '${orch.name}' has duplicate entry key ` +
              `'${entry.key}'. Keys must be unique within a registry.`,
          });
          continue;
        }
        seen.add(entry.key);
      }
    }

    // --- Rule 4: co-keyed registry keyType consistency ---
    // ADR-032 Decision 2: co-keyed registries share a key space — same keyType.
    if (orch.coKeyedRegistries && orch.coKeyedRegistries.length > 0) {
      const primaryKeyType = orch.registry.keyType;
      for (const reg of orch.coKeyedRegistries) {
        if (reg.keyType !== primaryKeyType) {
          issues.push({
            severity: 'error',
            type: 'pattern_cokeyed_keytype_mismatch',
            entity: '<project>',
            message:
              `Orchestration pattern '${orch.name}' co-keyed registry has ` +
              `keyType '${reg.keyType}', expected '${primaryKeyType}'. ` +
              `Co-keyed registries must share the primary registry's key space (ADR-032 Decision 2).`,
          });
        }
      }
    }
  }

  return issues;
}
```

### Issue type inventory (for builder)

| `type` string | Severity | Rule |
|---|---|---|
| `pattern_name_collision` | error | Domain ↔ orchestration name share |
| `pattern_entries_empty` | error | Registry with no entries |
| `pattern_entry_malformed` | error | Entry missing/non-string key or provider |
| `pattern_entry_key_duplicate` | error | Two entries in one registry share a key |
| `pattern_cokeyed_keytype_mismatch` | error | Co-keyed registry diverges from primary |

### Loader-time check (amends Section 4)

`loadAppPatterns()` must detect orchestration ↔ orchestration name collisions before `.set()` overwrites silently. Add to the orchestration branch:

```ts
if (ORCHESTRATION_APP_PATTERNS.has(val.name)) {
  errors.push(
    `Orchestration pattern '${val.name}' in ${rel} duplicates a previously ` +
    `loaded orchestration pattern. Pattern names must be unique.`,
  );
  continue;
}
```

The same protection should apply to domain patterns. **Open question (Section 7):** today's loader silently overwrites domain duplicates — should this PR fix that too, or stay scoped to orchestration?

### Deferred rules (explicit non-goals for Phase 3-1)

ADR-032 §"Composition rules" lists four conflicts. Two of them require reading consumer source code that Phase 3-1 cannot import:

- **`keyType`/`valueType` resolution** (row 2): defer to Phase 3-2. The codegen emission step has the consumer source tree resolved; it can verify the type alias resolves before emitting. Phase 3-1 stores the strings verbatim.
- **Provider not exported by any known module** (row 3): defer to Phase 3-2 + DI runtime. Phase 3-2 emits the import; DI validates at boot. Spec note: emit a warning here in Phase 3-2, not an error, per ADR-032's table.

**Update ADR-032 §"Composition rules"** in the same PR to mark rows 2 and 3 as "Phase 3-2 emission" rather than "generation-time" with no further detail. See doc-updates section.

---

## 6. `analyzeDomain` integration

In `src/index.ts`, after the existing `validatePatternProject` call:

```ts
const orchestrationProjectIssues = validateOrchestrationProject({
  orchestrationPatterns: getAllOrchestrationPatterns(),
  domainPatternNames: getAllPatternNames(),
});

const allIssues = [
  ...loadIssues,
  ...relLoadIssues,
  ...resolveIssues,
  ...relResolveIssues,
  ...consistencyIssues,
  ...patternIssues,
  ...patternProjectIssues,
  ...orchestrationProjectIssues,  // <-- new
];
```

`getAllPatternNames()` returns library + app domain names already (it's the union of `LIBRARY_PATTERNS.keys()` + `APP_PATTERNS.keys()`). Confirm it does NOT include orchestration names (it shouldn't, since we route orchestration to a separate map). The collision rule (Rule 1) compares orchestration names against this domain-only set — that's exactly what we want.

---

## 7. Test plan

### Fixtures (`src/__tests__/patterns/fixtures/orchestration/`)

| File | Shape | Purpose |
|---|---|---|
| `valid-crm-ports.pattern.ts` | Single registry, two entries, dispatcher block | Happy path |
| `valid-co-keyed-crm.pattern.ts` | Primary + one coKeyedRegistry, matching keyType | Co-keyed happy path |
| `name-collision-with-domain.pattern.ts` | `name: 'Synced'` (library pattern name) | Triggers `pattern_name_collision` |
| `duplicate-entry-key.pattern.ts` | Two entries with `key: 'salesforce-crm'` | Triggers `pattern_entry_key_duplicate` |
| `malformed-entries.pattern.ts` | Empty `entries: []` and one entry with empty key | Triggers `pattern_entries_empty` + `pattern_entry_malformed` |
| `cokeyed-mismatch.pattern.ts` | Co-keyed registry with different keyType | Triggers `pattern_cokeyed_keytype_mismatch` |

Fixtures live as `.pattern.ts` files (not YAML) — they exercise both the loader path AND the validator. Use `defineOrchestrationPattern({...})` so type errors in the fixture surface at compile time.

### Tests (`src/__tests__/patterns/validate-orchestration.test.ts`)

Mirror the structure of `validate-composition.test.ts`:

1. **Happy path** — register `valid-crm-ports`, `valid-co-keyed-crm`. Validator returns `[]`.
2. **Domain ↔ orchestration name collision** — register `name-collision-with-domain` alongside library `Synced`. Expect one `pattern_name_collision` issue.
3. **Duplicate entry key** — load `duplicate-entry-key`. Expect one `pattern_entry_key_duplicate`.
4. **Empty entries** — load `malformed-entries`. Expect `pattern_entries_empty`. (Note: loader's `assertOrchestrationContribution` may catch the empty case earlier — if so, this case tests loader errors instead. Builder picks one consistent layer.)
5. **Malformed entry** — entry with missing `provider`. Expect `pattern_entry_malformed`.
6. **Co-keyed keyType mismatch** — `cokeyed-mismatch`. Expect `pattern_cokeyed_keytype_mismatch`.
7. **Loader-level orchestration name duplicate** — register the same orchestration pattern name from two fixture files. Expect `LoadAppPatternsResult.errors` to contain a duplicate-name message.
8. **`afterAll` cleanup** — same pattern as `validate-composition.test.ts` (reset registry, re-register canonical library patterns).

---

## 8. Open questions

1. **Loader: should the same duplicate-name protection apply to domain patterns now?** Today's `APP_PATTERNS.set(val.name, val)` silently overwrites. Suggested answer: yes, fix in this PR — it's a small symmetric change and avoids re-touching the loader in Phase 3-2. Flag for builder confirmation.
2. **Library orchestration patterns in Phase 3-1?** Spec assumes none ship. ADR-032 doesn't ship one either. If Phase 3-2 wants to ship a reference orchestration pattern (e.g. for documentation), the registry will need a `LIBRARY_ORCHESTRATION_PATTERNS` map. Defer until then.
3. **Fixture loading mechanism in tests:** `validate-composition.test.ts` registers patterns inline via `registerLibraryPattern()`. For orchestration we have no `registerLibraryOrchestrationPattern()` — should one be added (test-only API) or should the tests construct `OrchestrationPatternDefinition` literals and pass directly to `validateOrchestrationProject({orchestrationPatterns: [...]})`? Spec recommends the latter (cleaner, mirrors the validator signature).
4. **Issue `entity` field for project-level orchestration issues:** existing project-level issues (`pattern_clean_pipeline_noop`) attach to a real entity name. Orchestration issues have no entity — spec uses `'<project>'` sentinel string. Confirm this fits `AnalysisIssue` consumers (formatters, CLI output). If they require `string`, sentinel works; if they want `string | undefined`, change `entity` to optional.

---

## 9. Out of scope (head off scope creep)

- All template work (`templates/orchestration/**`) — Phase 3-2/3-3.
- Token file emission, `DynamicModule` emission, dispatcher class emission.
- `paths.orchestration_src` config key — Phase 3-2 (no validator needs it).
- Runtime base classes for orchestration — none planned.
- Library-shipped orchestration patterns.
- CLI changes (no new noun, no new flag) — `analyzeDomain` is the integration surface.
- Frontend or DTO emission.
- ADR-032 Decision 6 (`forRoot({ overrides })`) — emission concern.
- Dispatcher subclass-extension contract enforcement — emission concern.
- Type-resolution of `keyType`/`valueType` strings against the consumer's tsconfig — Phase 3-2.
- Provider class export verification — Phase 3-2.
- Any change to existing domain-pattern validation rules.

---

## 10. Doc updates required in same PR (living-docs rule)

- `docs/adrs/ADR-032-orchestration-patterns.md` §"Composition rules":
  - Annotate row 2 (`keyType` resolution) and row 3 (provider not exported) as "Phase 3-2 emission-time check" rather than "generation-time" with no qualifier. The Phase 3-1 validator cannot enforce these without consumer source-tree access.
  - Add a note under §"Implementation sequence" Phase 3-1 step 3 listing the issue-type strings the validator emits (cross-references this spec).
- `docs/adrs/ADR-031-app-defined-patterns.md` §5 (Discovery):
  - Note that the app-pattern loader now routes by `kind` into one of two maps. Brief — one paragraph.
- `src/patterns/pattern-definition.ts` JSDoc:
  - Top-of-file comment mentions both pattern kinds and links to ADR-032.
  - JSDoc on `isPatternDefinition()` notes the function is intentionally kind-agnostic — discriminator routing happens in the loader.

---

## 11. Builder effort estimate

**S–M.** The type extension and validator are mechanical mirrors of existing code. The registry split is the only place that requires care (don't break the existing two-process determinism test). Test fixtures + 7 unit tests are routine. No template work, no runtime work, no CLI work. Expect 4–6 files modified, 6–8 files added.
