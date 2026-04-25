# Phase 3-2 + 3-3 Emission Plan — Orchestration Patterns

**Status:** Implemented (Phase 3-2 + 3-3 shipped on `main`).
**Relates to:** ADR-032, Phase 3-1 (already shipped)
**Scope:** Codegen emission of `src/orchestration/${slug}/` modules from `OrchestrationPatternDefinition` records. Byte-identical golden test against a CRM-shaped fixture.

This plan does **not** restate ADR-032 — it assumes Decisions 3, 4, 5, 6, 7 are locked. It resolves the layer between the registry record and the files on disk.

---

## 1. File-by-file template design

Emission is per-pattern, one directory per `OrchestrationPatternDefinition`:

```
${paths.orchestration_src}/${pattern-slug}/
  tokens.ts              Decision 3
  registry.providers.ts  Decision 6 provider block
  dispatcher.ts          Decisions 4 + 5
  module.ts              Decision 6 DynamicModule
  index.ts               barrel re-exports
```

`${pattern-slug}` = kebab-case of `pattern.name` (e.g. `CrmPorts` → `crm-ports`). `${PatternName}` = PascalCase (identity), `${PATTERN_CONST}` = SCREAMING_SNAKE_CASE of the slug.

### 1.1 Worked example — input

```ts
defineOrchestrationPattern({
  name: 'CrmPorts',
  kind: 'orchestration',
  registry: {
    keyType: 'CrmAdapterDomain',
    valueType: 'ICrmPort',
    entries: [
      { key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' },
      { key: 'hubspot-crm',    provider: 'HubSpotCrmAdapter' },
    ],
  },
  coKeyedRegistries: [
    {
      keyType: 'CrmAdapterDomain',
      valueType: 'IAuthStrategy',
      entries: [
        { key: 'salesforce-crm', provider: 'SalesforceAuthStrategy' },
        { key: 'hubspot-crm',    provider: 'HubSpotAuthStrategy' },
      ],
    },
  ],
  dispatcher: { className: 'CrmPortsDispatcher', assemblySlot: 'build' },
});
```

### 1.2 `tokens.ts`

Hygen template: `templates/orchestration/new/tokens.ejs.t`.

```ts
// AUTO-GENERATED — do not edit. See docs/adrs/ADR-032.
import type { CrmAdapterDomain } from '<%= registry.keyTypeImport %>';
import type { ICrmPort } from '<%= registry.valueTypeImport %>';
import type { IAuthStrategy } from '<%= coKeyed[0].valueTypeImport %>';

export const CRM_PORTS_REGISTRY      = Symbol('CRM_PORTS_REGISTRY');
export const CRM_PORTS_AUTH_REGISTRY = Symbol('CRM_PORTS_AUTH_REGISTRY');

export type CrmPortsRegistryMap     = Map<CrmAdapterDomain, ICrmPort>;
export type CrmPortsAuthRegistryMap = Map<CrmAdapterDomain, IAuthStrategy>;
```

Symbol name per registry is `${PATTERN_CONST}_REGISTRY` for the primary and `${PATTERN_CONST}_${NAME_UPPER}_REGISTRY` for co-keyed siblings, where `${NAME_UPPER}` is the SCREAMING_SNAKE form of the sibling's required `name:` field (locked O-1; no auto-stripping of `I` prefixes or `Strategy/Port/Adapter/Provider` suffixes — authors pick the identifier that reads right). The implementation rejects co-keyed siblings missing `name:` with `pattern_cokeyed_missing_name` at emission time.

### 1.3 `registry.providers.ts`

Template: `registry.providers.ejs.t`. Emits one `useFactory` Provider per registry + the frozen-Map build. The provider list is consumed by `module.ts` via a named export.

```ts
import { Provider } from '@nestjs/common';
import { SalesforceCrmAdapter } from '<%= entries[0].providerImport %>';
import { HubSpotCrmAdapter }    from '<%= entries[1].providerImport %>';
import { SalesforceAuthStrategy } from '<%= coKeyed[0].entries[0].providerImport %>';
import { HubSpotAuthStrategy }    from '<%= coKeyed[0].entries[1].providerImport %>';
import {
  CRM_PORTS_REGISTRY,
  CRM_PORTS_AUTH_REGISTRY,
  type CrmPortsRegistryMap,
  type CrmPortsAuthRegistryMap,
} from './tokens.js';
import type { CrmPortsForRootOptions } from './module.js';

export function buildCrmPortsRegistryProviders(
  opts?: CrmPortsForRootOptions,
): Provider[] {
  return [
    {
      provide: CRM_PORTS_REGISTRY,
      useFactory: (sfdc: SalesforceCrmAdapter, hubspot: HubSpotCrmAdapter) => {
        const base: CrmPortsRegistryMap = new Map([
          ['salesforce-crm', sfdc],
          ['hubspot-crm',    hubspot],
        ]);
        if (opts?.overrides) {
          for (const [k, v] of Object.entries(opts.overrides)) {
            base.set(k as CrmAdapterDomain, v);
          }
        }
        return Object.freeze(base);
      },
      inject: [SalesforceCrmAdapter, HubSpotCrmAdapter],
    },
    {
      provide: CRM_PORTS_AUTH_REGISTRY,
      useFactory: (sfdc: SalesforceAuthStrategy, hubspot: HubSpotAuthStrategy) => {
        const base: CrmPortsAuthRegistryMap = new Map([
          ['salesforce-crm', sfdc],
          ['hubspot-crm',    hubspot],
        ]);
        if (opts?.authOverrides) {
          for (const [k, v] of Object.entries(opts.authOverrides)) {
            base.set(k as CrmAdapterDomain, v);
          }
        }
        return Object.freeze(base);
      },
      inject: [SalesforceAuthStrategy, HubSpotAuthStrategy],
    },
  ];
}
```

Provider-class names AND factory-local names in `inject:` / `useFactory` args are emitted 1:1 from `entry.provider`; preserve declaration order so the `inject:` array index matches the factory-arg index (EJS `forEach` with explicit index).

### 1.4 `dispatcher.ts` — the non-obvious one

Template: `dispatcher.ejs.t`. Decision 4 requires **one overload per entry, plus one fallback signature + implementation**. Overload signatures must precede the implementation signature in TypeScript; implementation return type is the widest (`valueType`).

EJS shape (single `select` method, primary registry only):

```ejs
<%_ entries.forEach(function (e) { -%>
  select(key: '<%= e.key %>'): <%= e.provider %>;
<%_ }); -%>
  select(key: <%= registry.keyType %>): <%= registry.valueType %>;
  select(key: <%= registry.keyType %>): <%= registry.valueType %> {
    const entry = this.registry.get(key);
    if (!entry) throw new <%= dispatcher.className %>Error(
      `Unknown <%= registry.keyType %>: ${String(key)}`,
    );
    return entry;
  }
```

When `coKeyedRegistries` is present, each sibling gets its **own** method named `select${NamePascal}` where `Name` is the sibling's required `name:` field. For `name: 'auth'` ⇒ `selectAuth(key: ...)`. Each such method re-emits the same overload pattern against the sibling's entries + valueType. This keeps type-narrowing per-registry and avoids invented tuple types.

Full rendered output for the worked example:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { CrmAdapterDomain } from '<%= registry.keyTypeImport %>';
import type { ICrmPort }         from '<%= registry.valueTypeImport %>';
import type { IAuthStrategy }    from '<%= coKeyed[0].valueTypeImport %>';
import { SalesforceCrmAdapter, HubSpotCrmAdapter /* ... */ } from '...';
import { SalesforceAuthStrategy, HubSpotAuthStrategy }        from '...';
import {
  CRM_PORTS_REGISTRY, CRM_PORTS_AUTH_REGISTRY,
  type CrmPortsRegistryMap, type CrmPortsAuthRegistryMap,
} from './tokens.js';

export class CrmPortsDispatcherError extends Error {}

@Injectable()
export class CrmPortsDispatcher {
  constructor(
    @Inject(CRM_PORTS_REGISTRY)      protected readonly registry:     CrmPortsRegistryMap,
    @Inject(CRM_PORTS_AUTH_REGISTRY) protected readonly authRegistry: CrmPortsAuthRegistryMap,
  ) {}

  select(key: 'salesforce-crm'): SalesforceCrmAdapter;
  select(key: 'hubspot-crm'):    HubSpotCrmAdapter;
  select(key: CrmAdapterDomain): ICrmPort;
  select(key: CrmAdapterDomain): ICrmPort {
    const entry = this.registry.get(key);
    if (!entry) throw new CrmPortsDispatcherError(`Unknown CrmAdapterDomain: ${String(key)}`);
    return entry;
  }

  selectAuth(key: 'salesforce-crm'): SalesforceAuthStrategy;
  selectAuth(key: 'hubspot-crm'):    HubSpotAuthStrategy;
  selectAuth(key: CrmAdapterDomain): IAuthStrategy;
  selectAuth(key: CrmAdapterDomain): IAuthStrategy {
    const entry = this.authRegistry.get(key);
    if (!entry) throw new CrmPortsDispatcherError(`Unknown CrmAdapterDomain: ${String(key)}`);
    return entry;
  }

  // Decision 5 — `assemblySlot: 'build'` is a *subclass contract*, not
  // emitted here. Consumers subclass and add `build(...)` themselves.
  // This class is final-shape safe but not `final`.
}
```

Note: `assemblySlot` is documentation-only in the emitted dispatcher. It does NOT emit an abstract method stub (that would force consumer subclasses to exist even when only the base `select()` is needed). See O-4.

### 1.5 `module.ts`

Template: `module.ejs.t`.

```ts
import { DynamicModule, Module } from '@nestjs/common';
import type { CrmAdapterDomain } from '<%= registry.keyTypeImport %>';
import type { ICrmPort }         from '<%= registry.valueTypeImport %>';
import type { IAuthStrategy }    from '<%= coKeyed[0].valueTypeImport %>';
import { buildCrmPortsRegistryProviders } from './registry.providers.js';
import { CrmPortsDispatcher } from './dispatcher.js';
import { CRM_PORTS_REGISTRY, CRM_PORTS_AUTH_REGISTRY } from './tokens.js';

export interface CrmPortsForRootOptions {
  overrides?:     Partial<Record<CrmAdapterDomain, ICrmPort>>;
  authOverrides?: Partial<Record<CrmAdapterDomain, IAuthStrategy>>;
}

@Module({})
export class CrmPortsOrchestrationModule {
  static forRoot(opts?: CrmPortsForRootOptions): DynamicModule {
    return {
      module:    CrmPortsOrchestrationModule,
      providers: [...buildCrmPortsRegistryProviders(opts), CrmPortsDispatcher],
      exports:   [CRM_PORTS_REGISTRY, CRM_PORTS_AUTH_REGISTRY, CrmPortsDispatcher],
    };
  }
}
```

Module class naming: `${PatternName}OrchestrationModule` — suffixing with `OrchestrationModule` matches ADR-032 Decision 7's "name the layer" framing.

### 1.6 `index.ts`

Template: `index.ejs.t`. Barrel — re-exports tokens, map types, dispatcher class + error, module, and the ForRoot options type. Pure re-exports; static file is template-constant modulo the pattern identifiers.

---

## 2. Config loader changes

### 2.1 New key

`codegen.config.yaml`:

```yaml
paths:
  orchestration_src: app/backend/src/orchestration   # default = `${backend_src}/orchestration`
```

The default tracks `paths.backend_src` (locked O-6); pass an explicit `orchestration_src` to override.

### 2.2 Additions in `src/config/paths.mjs`

Add to `BASE_PATHS`:

```js
orchestrationSrc:
  projectConfig?.paths?.orchestration_src ??
  `${projectConfig?.paths?.backend_src ?? 'app/backend/src'}/orchestration`,
```

Add a helper mirroring `getBackendPath`:

```js
export function getOrchestrationPath(slug = '') {
  return joinPath(BASE_PATHS.orchestrationSrc, slug);
}
```

Additionally extend `src/config/paths.ts` (TS config-loader) with a matching entry in whatever Zod schema validates `paths` — grep shows `src/schema/config.schema.*` (verify exact path during build). Default must be equal in both mjs and ts sides.

### 2.3 How codegen reads it

The orchestration emission pipeline (see §3) calls `getOrchestrationPath(slug)` to compute the target directory for each pattern. No `entity` paths are touched. `INJECTABLE_FILES` and `TEST_OUTPUT_PATHS` arrays get appended with `${orchestrationSrc}` so baseline runners wipe it between iterations.

---

## 3. Codegen pipeline changes

### 3.1 Proposal: new CLI verb `codegen orchestration gen`

**Pick: new noun** — `src/cli/commands/orchestration.ts`, registered like `entity` / `subsystem`. Verbs: `gen` (primary), `list`, `validate` (re-uses Phase 3-1 `validate-orchestration.ts`).

**Justification:**

1. Orchestration patterns have **no entity YAML**. They live in `src/patterns/*.pattern.ts` and are discovered via `loadAppPatterns()` — the same discovery the `entity new` Hygen prompt already runs for domain patterns. Tying emission to `entity new` would force every `entity new` run to re-emit the whole `src/orchestration/` tree; that is wrong on architectural grounds (orchestration output lifecycle is independent of any entity's lifecycle).
2. The `subsystem` verb is the nearest precedent: subsystems are installed/generated per-project, not per-entity. Orchestration patterns fit the same noun shape (whole-pattern-at-a-time, no YAML-per-invocation).
3. `entity new` already runs three non-entity post-steps (barrels, scope-entity-type, event codegen, bridge registry). Adding a fourth whose inputs never change based on which entity is generated would be "coupling by proximity."

**Shape:**

```
codegen orchestration gen [--pattern CrmPorts] [--all] [--dry-run] [--force]
codegen orchestration list
codegen orchestration validate
```

Defaults: `--all` implicit when no `--pattern` is passed, matching `entity new --all`.

### 3.2 Hook from `entity new`

`entity new` still needs to trigger orchestration emission so a single `just gen-all` continues to be a "build everything" entry point. The cleanest wiring: after `generateBridgeRegistry` in `entity.ts`, call a new `generateOrchestrationModules()` helper (same warn-but-don't-fail pattern as the other post-steps). The helper is the same function `codegen orchestration gen --all` calls internally. `entity new --dry-run` reports orchestration plans in the JSON payload alongside `bridgeRegistry`.

### 3.3 Emission helper shape

New file: `src/cli/shared/orchestration-generator.ts`. Mirrors `event-codegen-generator.ts`:

- Pure content-builder functions (one per emitted file: `buildTokensTs`, `buildProvidersTs`, `buildDispatcherTs`, `buildModuleTs`, `buildIndexTs`). Unit-testable without disk.
- One orchestrating entrypoint `generateOrchestrationModules({ patterns, outputRoot, dryRun })` that does disk I/O.
- Input: the `getAllOrchestrationPatterns()` array from `src/patterns/registry.ts`.

**Why pure TS, not Hygen templates?** (see Risk R-2) — The overload loop, frozen-map factory, and per-registry dispatcher method emission are easier to get byte-identical and easier to unit-test as TS template literals than EJS. The rest of the codegen pipeline already uses this exact shape for event codegen, bridge registry, and scope-entity-type. **Recommendation: do NOT use Hygen for orchestration.** Operator gate: O-2.

If the operator rules "use Hygen anyway" then templates land under `templates/orchestration/new/` following `templates/subsystem/events/` conventions, with a `prompt.js` that takes `--pattern <name>` and reads the registry the same way `entity/new/prompt.js` does (via `ensurePatternsRegistryLoaded()`).

### 3.4 Import-path resolution

Phase 3-1 stores `keyType` / `valueType` / `provider` as bare strings. Phase 3-2 must resolve these to import paths. Options:

- **A. YAML-level extension** — add `keyTypeImport`, `valueTypeImport`, `providerImport` to `OrchestrationRegistrySpec`. Authoring tax is moderate; consumer always knows the answer. **Recommended.** See O-3.
- **B. tsconfig-driven resolution** — walk `paths` aliases to find the type. Fragile, heavy lift, identical emission cost.

Assuming A: extend Phase 3-1 schema with three optional string fields; validator emits a new `pattern_missing_import_path` error at Phase 3-2 emission time if absent.

---

## 4. Golden-test layout

### 4.1 Fixture

```
src/__tests__/patterns/fixtures/orchestration/
  valid-crm-ports.pattern.ts        (already exists — extend with coKeyedRegistries + imports)
  baseline/
    crm-ports/
      tokens.ts
      registry.providers.ts
      dispatcher.ts
      module.ts
      index.ts
```

Baseline files are hand-written once, formatted with the same Biome config the baseline runner uses (see `test/run-test.ts:270` — formatter runs post-generation). CI fails on any diff.

### 4.2 Test harness

New test file: `src/__tests__/patterns/orchestration-emission.test.ts`.

```ts
describe('orchestration emission — golden output', () => {
  it('CrmPorts matches baseline byte-for-byte', async () => {
    const pattern = await loadFixturePattern('valid-crm-ports.pattern.ts');
    const result = generateOrchestrationModules({
      patterns: [pattern],
      outputRoot: tmpDir,
      dryRun: true,          // use file-output array, avoid disk churn
    });
    for (const f of result.files) {
      const baseline = readFileSync(join(BASELINE_DIR, f.relativePath), 'utf-8');
      expect(f.content).toEqual(baseline);
    }
  });
});
```

Uses the `files: [{ relativePath, content }]` shape the other codegen generators already return in dry-run mode — no disk writes, no format step in the test itself (fixtures pre-formatted).

### 4.3 Integration with `just test-baseline`

The `test/baseline/packages/api/src/` tree is entity-driven and is regenerated by `test/run-test.ts`. Orchestration emission should **not** piggyback on that runner (no YAML-driven trigger). Instead, wire a second sandbox test into `just test-baseline` that:

1. Writes `valid-crm-ports.pattern.ts` into a tmp `src/patterns/` dir.
2. Runs `codegen orchestration gen --all --cwd <tmp>`.
3. Compares emitted tree to `src/__tests__/patterns/fixtures/orchestration/baseline/`.

The in-unit-test comparison (§4.2) is the fast path (ms), the sandbox comparison is end-to-end (seconds). Both run in CI.

---

## 5. Open questions — RESOLVED 2026-04-23

All 9 operator gates locked. Decisions in §5.1, original tradeoff writeups preserved in §5.2 for future reference.

### 5.1 Locked decisions

| Gate | Locked answer |
|---|---|
| O-1 | **Explicit `name` field per co-keyed registry.** Author writes `coKeyedRegistries: [{ name: 'auth', valueType: 'IAuthStrategy', ... }]`; emitter derives `${PATTERN_CONST}_${NAME_UPPER}_REGISTRY` token + `select${NamePascal}()` method. No auto-stripping — user picks what reads right. |
| O-2 | **Pure-TS template literals.** Mirrors `event-codegen-generator.ts` / `bridge-registry-generator.ts`. No Hygen. |
| O-3 | **Add import-path fields to schema.** Extend `OrchestrationRegistrySpec` (Phase 3-1) with optional `keyTypeImport`, `valueTypeImport`, `providerImport`. Validator emits `pattern_missing_import_path` at emission time if absent. |
| O-4 | **Emit nothing in dispatcher base.** No hook, no mixin. Followup issue #224 tracks unifying observability hooks across ALL pattern-emitted bases (repo, service, entity, dispatcher) in one design pass. |
| O-5 | **Reuse `case-converters.mjs` `kebab-case`.** |
| O-6 | **Default `${backend_src}/orchestration`**, tunable via `paths.orchestration_src`. |
| O-7 | **Top-level barrel `${orchestration_src}/index.ts`** re-exports every pattern's module. |
| O-8 | **`pattern_keytype_unresolved` surfaces in the generator**, not the validator. |
| O-9 | **`registry.providers.ts` stays split from `module.ts`** for testability. |

### 5.2 Original tradeoff writeups

**O-1. Co-keyed symbol + method naming rule.** ADR-032 names the primary registry's token `${PATTERN_CONST}_REGISTRY` but says nothing about siblings. Proposal: sibling tokens are `${PATTERN_CONST}_${VALUE_TYPE_SLUG}_REGISTRY` where `VALUE_TYPE_SLUG` strips leading `I` and trims common suffixes (`Strategy`, `Port`, `Adapter`, `Provider`). Sibling dispatcher methods are `select${VALUE_TYPE_SLUG}`. This affects every co-keyed pattern the project ever emits — **must be locked before builder starts.**

**O-2. Hygen vs pure-TS generator.** §3.3 recommends pure TS. Hygen adds EJS-overload-emission risk (R-2) for no gain that the existing event-codegen-generator pattern doesn't already cover. Operator call.

**O-3. Import-path field at YAML/schema level.** Phase 3-1 stores types and providers as bare strings; Phase 3-2 must know where to import them from. §3.4 recommends adding three optional import-path fields to `OrchestrationRegistrySpec`. Alternative is tsconfig-walking, which is substantial work. Operator call.

**O-4. Assembly-slot emission.** ADR-032 Decision 5 says the dispatcher is subclassable and the consumer fills `assemblySlot`. Should the base class emit a throwing stub (`build(): never { throw new NotImplemented() }`), an abstract method (forces subclassing), or nothing (current proposal)? The "nothing" path lets the base dispatcher be used directly when only `select()` is needed. Recommendation: nothing. Operator call.

**O-5. Slug derivation from PascalCase name.** `CrmPorts` → `crm-ports` is obvious. `IAMPolicies` → `i-a-m-policies` or `iam-policies`? Proposal: use the same slug utility the entity pipeline uses (check `src/config/case-converters.mjs` — see "applyCase('kebab-case')"). Confirm.

**O-6. `paths.orchestration_src` default.** ADR-032 §7 says `src/orchestration/`. The existing config defaults use `src/generated`, `app/backend/src`, etc. Is `src/orchestration` correct for projects where `paths.backend_src = 'app/backend/src'`? Likely should be `${paths.backend_src}/orchestration` for consistency with `src/modules/` and `src/subsystems/` living under the same root. **Clarify before landing — the default is user-facing.**

**O-7. Re-export through the main barrel.** Does `src/orchestration/` get a top-level `index.ts` that re-exports every pattern's module? Useful for `import { CrmPortsOrchestrationModule } from '@/orchestration'` but means barrel regeneration on every add. Recommendation: yes, mirroring `src/generated/modules.ts`. Operator call.

**O-8. Phase 3-1 emitted-time error — `pattern_keytype_unresolved`.** ADR-032 composition-rules table row 2 says this is an "emission-time hard error." Where does it surface — in `validate-orchestration.ts` (which currently runs at `analyzeDomain`) or in the new orchestration generator? Recommendation: the generator, because resolution needs the tsconfig + source tree. Confirm validator contract doesn't need extension.

**O-9. Whether `registry.providers.ts` is a separate file at all.** The factory array could inline into `module.ts`. Splitting it out makes per-pattern testability easier (operator can import `buildCrmPortsRegistryProviders` in an isolated test) and keeps `module.ts` short. Recommendation: keep split. Operator call if they'd prefer single-file per pattern.

---

## 6. Risk flags

**R-1. TypeScript overload-ordering gotcha.** Overload signatures must appear in the same class body in specific-to-general order, and the implementation signature must come last and be assignable from all overloads. The emitter has to loop entries first, then emit the widening fallback, then the impl. EJS can do this but the generator MUST unit-test the "one entry" and "zero entries" degenerate cases — phase 3-1 rejects zero-entries at load time, but the generator should still assert-fail cleanly if it gets one. Belt-and-braces.

**R-2. EJS loop-with-trailing-separator weirdness.** Emitting a TS union or tuple type (`'salesforce-crm' | 'hubspot-crm'`) with correct pipes and no trailing separator is a well-known EJS pitfall. The overload-list case avoids this (each overload is its own statement), but any future addition that emits inline unions needs care. Not hard to get right, easy to ship a subtle trailing-comma bug into a golden test. Pure-TS template literals (§3.3) sidestep this entirely — one more argument for O-2=pure-TS.

**R-3. `Partial<Record<K, V>>` with string-literal K.** TypeScript allows `Partial<Record<CrmAdapterDomain, ICrmPort>>` where `CrmAdapterDomain` is a string-literal union but rejects it where it's `string`. Phase 3-1 stores `keyType` as an opaque string — if a consumer passes `keyType: 'string'` the emitted `forRoot` opts signature will be wrong. Validator should reject `keyType === 'string' | 'number' | 'symbol' | 'any' | 'unknown'`. Add to Phase 3-1's `validate-orchestration.ts` in the same PR if not already present.

**R-4. Dispatcher subclassing + `protected` members.** The constructor-injected `registry` / `authRegistry` must be `protected readonly` (so subclasses see them) not `private`. Easy to get wrong on the first emission pass. Golden test covers it but worth flagging.

**R-5. Biome formatting flicker.** The baseline runner formats emitted TS with Biome before comparing (see `test/run-test.ts:270`). Golden-test fixtures must be pre-formatted with the same Biome config — any drift will show as a one-character diff. Bake a `biome format --write` step into the fixture-build instructions.

**R-6. Provider-class collision across patterns.** Two different orchestration patterns whose entries reference a class named `SalesforceCrmAdapter` will both emit an `import { SalesforceCrmAdapter }` — fine, but if the import paths differ (different `providerImport` values) the second import fails compilation. Validator currently has no cross-pattern provider-import check. Low-priority follow-up.

**R-7. `DynamicModule` + `global: true`.** ADR-008 subsystems use `global: true`. Orchestration modules don't currently — each consumer has to import `CrmPortsOrchestrationModule.forRoot()` in their feature module. That's the intended behaviour per Decision 7 ("coordinates across CRM + integrations + events") but flagging so the operator can override before landing.

---

## 6.1 Implementation notes (post-ship, 2026-04-25)

- **Zero-pattern emission is a no-op on disk.** When the registry contains
  no orchestration patterns, the actual generation pass writes nothing —
  consumers without a `src/patterns/` tree don't see a stray empty
  `orchestration/` directory after `entity new`. Dry-run plans still
  include the would-be top-level barrel for visibility.
- **`pattern_cokeyed_missing_name` is the new emission-time error code.**
  Locked O-1 made the sibling `name:` mandatory; the generator throws
  `OrchestrationEmissionError` on missing names rather than silently
  picking a derived identifier. Tests cover this.
- **The `entity new` post-step warns-but-doesn't-fail.** The orchestration
  emission errors are surfaced via `printError` (for emission errors) and
  `printWarning` (for unexpected exceptions) but never abort the rest of
  the codegen pipeline — same contract as the bridge / events / scope
  post-steps.
- **Provider factory args are disambiguated by index** (e.g.
  `salesforceCrmAdapter_0`) rather than by class name. This keeps the
  emitter trivial when two registries import the same class name through
  different paths (R-6 in §6) — declaration order is the only thing that
  matters for the inject array, and the index suffix removes any factory-
  arg name collision.

## 7. Implementation order

1. **Config key + default path** (§2) — one commit, no behaviour change.
2. **Resolve O-1, O-2, O-3, O-6, O-9** — operator review of this plan.
3. **Schema extension** (§3.4 option A) — add import-path fields to `OrchestrationRegistrySpec`, extend validator. Updates the existing fixture.
4. **Content builders** (`src/cli/shared/orchestration-generator.ts`) — pure functions, unit-tested against the golden fixture via in-memory comparison.
5. **CLI verb** (`src/cli/commands/orchestration.ts`) — gen/list/validate.
6. **Wire from `entity new`** as a post-step — dry-run output in the JSON payload.
7. **Sandbox baseline test** — end-to-end trigger via `just test-baseline`.
8. **Documentation** — update ADR-032 with "implemented" notes where Phase 3-2/3-3 resolved ambiguities.
