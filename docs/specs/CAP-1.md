# CAP-1 — `kind: 'capability'` + composed-base emission (ADR-041 implementation)

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #593 · **Epic:** #582 · **Project:** #578
**Depends on:** DRZ-2 (#584), REL-0 (#603) · **Blocks:** CAP-2 (#594), CAP-3 (#595)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §6.2 ·
ADR-041 (the accepted decision this implements) · ADR-031 (pattern kinds) · `docs/specs/REL-0.md` (the repository
type parameter every mixin must thread)

## Why

ADR-041 is accepted and unbuilt. `PatternKind` is `'domain' | 'orchestration'`
(`src/patterns/pattern-definition.ts:47`) and clean-lite-ps takes the base class from `patterns[0]`
(`templates/entity/new/clean-lite-ps/prompt-extension.js:86-107`), silently dropping every later pattern's
`repositoryClass` / `serviceClass`. So `patterns: [Integrated, Group, Individual]` *validates* (ADR-031's
`validate-composition.ts`) but emits only `IntegratedEntityRepository` — the other two contribute nothing.

CAP-2 (`roles:`) and CAP-3 (`Actor` / `Communication`) are both capabilities in ADR-041's sense; neither can be
built until the mechanism exists. This PR builds exactly ADR-041's rulings and nothing else.

## Charter invariants this PR touches

- **I1 declare once** — a capability's method vocabulary is declared once (`forwarderMethods`) and read twice: by the
  generation-time collision check and by the service forwarder emitter. Forwarder *signatures* are never re-declared;
  they are derived from the repository method with `Parameters<>` / `ReturnType<>` (§M8).
- **I2 generated means regenerated** — `<entity>.composed-base.ts` is a complete-file `@generated` artifact with no
  author seam, emitted by the same `force: true` hygen pass as the repository.
- **I3 scope is ALS-fed** — no capability method and no forwarder takes a scope parameter. Mixins reach the
  repository's own `scopeAnd()` / `baseQuery()` choke point (§M1), which is where tenant, soft-delete and
  `userTracking` filters already apply.
- **I7 no backwards compat** — `patterns[0]` positional selection is **deleted**, not kept behind a flag.
  `patterns: [Integrated, Activity]` changes from "silently emits Integrated" to a hard error, and the two unit tests
  that pinned the old behaviour are rewritten to pin the error. No dual-authored old/new composition types.
- **I9 honest gates** — the new smoke is in `just test-all` (and therefore in CI) from the first commit. The two
  `any`s in the mixin contract are language-mandated and measured (§M2/§M3); `unknown` and `never` were both tried and
  both fail. No filters, no carve-outs.
- **I11 scope discipline** — `clean-lite-ps` only (ADR-041 §6). The `clean` pipeline consumes no patterns and stays
  known-red (#602): untouched, unfiltered, not repaired.

## Measured facts — TS 6.0.3, `drizzle-orm@1.0.0-rc.4`, consumer strictness

Every claim below was measured with `tsc` from **inside** the repo (charter §8 risk), against the real
`runtime/base-classes/**` on this branch (post-REL-0), under the flags a generated project actually gets — `bun init`'s
tsconfig merged with codegen's aliases: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`verbatimModuleSyntax`, `module: Preserve`, `moduleResolution: bundler`.

ADR-041's spike *modelled* the bases; these measurements use them.

| # | Claim | Result |
|---|---|---|
| **M1** | A mixin over a **generic** repository base can reach the base's `protected` members — `this.col(...)`, `this.baseQuery(...)`, `this.count()`, `this.findById(...)` | ✅ compiles. The TS17293 "mixins cannot see protected members" folklore does **not** apply to `abstract class M extends Base` where `Base` is a type parameter. This is what makes REL-0's `tableRef` / `col()` usable from a capability, and therefore what makes CAP-3 possible. |
| **M2** | The mixin's base constraint must use `(...args: any[])` | ❌ `never[]` → **TS2545** "A mixin class must have a constructor with a single rest parameter of type `any[]`". Language-mandated; identical to the shipped `WithAnalytics` (`runtime/base-classes/with-analytics.ts:15`). |
| **M3** | The entity slot of the constraint must be `any` | `BaseRepository<any, PgTable>` ✅ · `BaseRepository<unknown, PgTable>` ❌ (1 error) · `BaseRepository<never, PgTable>` ❌ (5 errors — a concrete repository is not assignable, and `EntityOf` collapses to `never`). |
| **M4** | `EntityOf<TBase>` / `TableOf<TBase>` need a **widening** fallback branch, not `never` | With `… ? TEntity : never`, `class X extends Cap(Spine<…>) {}` fails **TS2417** (static-side check): the checker instantiates `TBase` as `any`, `EntityOf<any>` resolves to `never`, and `Promise<Contact[]>` is not assignable to `Promise<never[]>`. With `: unknown` (entity) / `: PgTable` (table) the check passes — `Promise<Contact[]>` *is* assignable to `Promise<unknown[]>`. |
| **M5** | `class X extends Cap(Spine<Entity, typeof table>)` — the TS instantiation expression inside a mixin call | ✅ both inline (one capability) and via `abstract class XComposedBase extends Cap3(Cap2(Cap1(Spine<…>))) {}` (three). Same mechanism as the shipped `WithAnalytics(BaseService<Repo, Entity>)` (`service.ejs.t:39`). |
| **M6** | Abstract-member enforcement survives the chain | ✅ a concrete repository extending a 2-deep composed base over `IntegratedEntityRepository` that omits `integrationConfig` fails **TS2515** on the leaf. |
| **M7** | Generic method signatures survive | ✅ `members()` on a `BaseRepository<Contact, typeof contacts>` chain returns `Contact[]`; on `IntegratedEntityRepository<Deal, typeof deals, …>` it returns `Deal[]`. No collapse to `any`. |
| **M8** | A service forwarder can be typed from the repository method | ✅ `m(...args: Parameters<R['m']>): ReturnType<R['m']>` type-checks and forwards. Emitted **non-`async`** so a sync capability method forwards too (`async` + a non-`Promise` return type is TS1064). |

The probe was a scratch file inside the repo, deleted before commit; §M1–M8 reproduce it. The *shipped* form of the
same measurement is `runtime/base-classes/capability-mixin.ts` plus `just test-smoke-capability`, which compiles the
three-capability fixture against the real bases on every CI run — so a future RC or TS bump that breaks M1–M8 fails a
gate rather than needing a re-probe. These extend DRZ-2's A-checklist — see §"A-checklist additions".

## Design

### 1. The third kind (`src/patterns/pattern-definition.ts`)

```ts
export type PatternKind = 'domain' | 'orchestration' | 'capability';

export interface CapabilityPatternDefinition<TConfig = unknown> {
  name: string;
  kind: 'capability';
  /** Mixin function applied to the REPOSITORY `extends` chain. */
  mixin?: string;
  /** Module specifier for `mixin`. `@shared/…` is rewritten per runtime mode. */
  mixinImport?: string;
  /** Method names this capability contributes — the codegen-known vocab (ADR-041 §3). */
  forwarderMethods?: string[];
  /** Property the concrete repository fills with this capability's `config:` block. */
  configProperty?: string;
  columns?: PatternColumnContribution[];
  impliedBehaviors?: string[];
  configSchema?: ZodSchema<TConfig>;
  description?: string;
}

export type EntityPatternDefinition = PatternDefinition | CapabilityPatternDefinition;
export function defineCapabilityPattern<TConfig>(def: CapabilityPatternDefinition<TConfig>): …
export function isCapabilityPattern(def: AnyPatternDefinition): def is CapabilityPatternDefinition
```

A capability carries **no** `repositoryClass` / `serviceClass` — it is layered, never inherited (ADR-041 §3).
Declaring one is a registration error.

`isDomainPattern()` changes from `!isOrchestrationPattern()` to an explicit `kind` check; `AnyPatternDefinition` gains
the capability arm.

**One store, not two.** Capabilities live in the same `LIBRARY_PATTERNS` / `APP_PATTERNS` maps as domain patterns and
resolve through the same `getPattern()`, because they are looked up the same way — by a name in the entity's
`patterns:` list. `getPattern()` returns `EntityPatternDefinition | undefined`. Orchestration stays in its own map
(it is not entity-attached). This also means a capability that shadows a domain pattern's name is caught by the
existing duplicate-name check, for free.

`assertHasContribution()` (ADR-041's Ruling: "accepts a mixin/forwarder contribution") branches on kind:

| Kind | Minimum contribution |
|---|---|
| domain | `columns` ∨ `repositoryClass` ∨ `serviceClass` (unchanged) |
| capability | `columns` ∨ `mixin` ∨ `forwarderMethods` |

plus two capability shape rules: `mixin` and `mixinImport` are all-or-nothing, and `repositoryClass`/`serviceClass`
are rejected.

### 2. Composition resolution (`src/patterns/compose.ts`, new)

One pure module, no registry import (the lookup is injected), so both callers share one implementation:

```ts
export function composePatterns(names: readonly string[], lookup): {
  spineName: string;                              // 'Base' when nothing contributes a base
  spine: PatternDefinition;
  capabilities: CapabilityPatternDefinition[];    // declaration order; rightmost = outermost (ADR-041 §6)
  unknown: string[];
  errors: CompositionError[];
}
export function detectMethodCollisions(vocabs: readonly MethodVocabulary[]): CompositionError[]
```

**Spine selection (Ruling #1).** Candidates are the declared **domain** patterns that contribute a
`repositoryClass` or `serviceClass`. A candidate that another candidate `extends` (ADR-031's single-depth chain) is
dropped as redundant — so `patterns: [Base, Integrated]` resolves to `Integrated`, not an error. Then:

- 0 candidates → spine = the library `Base` pattern;
- 1 candidate → that one, **wherever it sits in the list** (reordering `patterns:` cannot change the emitted base);
- ≥2 candidates → hard error:
  `Entity 'x' declares 2 inheritable spine bases (Integrated, Activity). Only one inheritable spine base is allowed; express the other capability as kind: 'capability'.`

**Deviation from ADR-041 §2, deliberate.** The ADR words the rule as "the pattern whose base carries an
abstract-config contract" and adds "no config-bearing base → spine = `Base`; all declared patterns layer as
capabilities". Implemented literally, `patterns: [Metadata]` would resolve to `BaseRepository` and drop `Metadata`
entirely, and `patterns: [Integrated, Metadata]` would silently drop `Metadata` — which is the exact defect ADR-041
opens with. Config-bearing-ness is also not machine-readable: `Activity` carries a `configSchema`, `Integrated`'s
`integrationConfig` contract is invisible to codegen (ADR-041 Context #1), so honouring the ADR's phrasing would need
a new declared flag whose only job is to reproduce a rule that "contributes an inheritable base" already expresses.
The implemented rule is the ADR's *constraint* — only one class can be inherited — stated directly, and it produces
the ADR's own worked example verbatim: `patterns: [Integrated, Activity]` is a hard error until one is authored as a
capability. Recorded in the ADR-041 revision note.

**Collision detection (Ruling #3).** `detectMethodCollisions` takes named vocabularies
(`{ source, methods }`) and reports every name that appears in two of them. Its scope is
**collisions that involve at least one capability**: capability × capability, capability × `queries:`,
capability × relationship forwarder. The pre-existing `queries:` × FK-traversal overlap is **not** reported —
it is a documented, *resolved* precedence rule with its own emission logic (`repository.ejs.t:9-31`), not an
undetected clash. Opaque spine-base methods stay a consumer `tsc` concern, per ADR-041 §4.

### 3. Where each check runs

| Check | Reported by | As |
|---|---|---|
| two spines | `validatePatternComposition` (analyze / `just validate-entities`) **and** the clean-lite-ps locals builder | `AnalysisIssue` `pattern_multiple_spines` (error) · a thrown `Error` at generation |
| capability × capability method collision | both | `AnalysisIssue` `pattern_method_collision` (error) · thrown |
| capability × `queries:` / relationship collision | the locals builder only | thrown (the analyzer does not compute emitted method names — deriving them there would be a second declaration of the naming rules, I1) |

Generation-time is the authoritative gate, as ADR-041 §4 requires; the validator is the earlier, cheaper report.

### 4. The capability mixin contract (`runtime/base-classes/capability-mixin.ts`, new)

Shipped so every capability author — CAP-3, and any consumer writing an app capability — writes the *one* shape that
survives §M3 and §M4 instead of rediscovering TS2417:

```ts
export type RepositoryCtor = abstract new (...args: any[]) => BaseRepository<any, PgTable>;
export type RepositoryOf<TBase extends RepositoryCtor> =
  TBase extends abstract new (...args: any[]) => infer TRepo ? TRepo : never;
export type EntityOf<TBase extends RepositoryCtor> =
  RepositoryOf<TBase> extends BaseRepository<infer TEntity, infer _TTable> ? TEntity : unknown;
export type TableOf<TBase extends RepositoryCtor> =
  RepositoryOf<TBase> extends BaseRepository<infer _TEntity, infer TTable> ? TTable : PgTable;
```

Three `any` occurrences across two declarations — the mixin rest parameter (twice) and the entity slot — each
measured as unavoidable (§M2, §M3) and each the same idiom the shipped `WithAnalytics` carries; two
`eslint-disable-next-line` comments. No `as unknown as`. A capability mixin is then:

```ts
export function WithX<TBase extends RepositoryCtor>(Base: TBase) {
  abstract class XMixin extends Base {
    protected readonly xConfig?: XConfig;                 // filled by the generated repository (public in a runtime-shipped mixin — CAP-3)
    async something(id: string): Promise<Array<EntityOf<TBase>>> {
      const rows = await this.baseQuery(eq(this.col('id'), id));   // ALS-scoped by baseQuery (I3)
      return rows as Array<EntityOf<TBase>>;
    }
  }
  return XMixin as TBase & typeof XMixin;
}
```

Mixins layer on the **repository**; `forwarderMethods` surface on the **service** (PLAN §6.4). There is no service
mixin chain — `WithAnalytics` stays the outermost service wrapper, untouched.

### 5. Emission (clean-lite-ps only)

`resolvePatternBaseClasses()` is **replaced** by `resolvePatternComposition()` (I7 — the old name and its
positional contract are deleted, not kept). New template locals:

| Local | Shape |
|---|---|
| `patternName` | the **spine** name (unchanged meaning for every existing fixture; `buildIntegrationSurface` still keys off `'Integrated'`) |
| `repositoryExtendsClause` | the full extends expression, built in JS |
| `capabilityMixins` | `[{ name, mixin, importPath, configProperty, config, hasConfig }]`, nesting order |
| `capabilityForwarders` | `[{ capability, method }]` |
| `composedBaseClass` / `composedBaseImport` | `'<Entity>ComposedBase'` / `'./<entity>.composed-base'`, or `null` |
| `clpOutputPaths.composedBase` | the file path, or `null` |

`repositoryExtendsClause` reproduces today's two forms **byte-identically** when no capability is declared —
`BaseRepository<X, typeof xs>` and the four-argument multi-line integrated form — so no existing snapshot moves.
With capabilities:

| Capabilities | Repository `extends` |
|---|---|
| 0 | `Spine<…>` (unchanged) |
| 1 | `WithA(Spine<…>)` — inline (ADR-041 §6) |
| ≥2 | `<Entity>ComposedBase` — a generated file (ADR-041 §6, readability) |

`<entity>.composed-base.ts` is `@generated`, `force: true`, and holds:

```ts
export abstract class AccountComposedBase extends WithAudited(
  WithIndividual(WithGroup(IntegratedEntityRepository<Account, typeof accounts, AccountIntegrationWrite, AccountIntegrationProjection>)),
) {}
```

For an `Integrated` spine the two integration interfaces are declared in `<entity>.repository.ts`, so the composed
base imports them **`import type`** from the repository that imports it back. The cycle is type-only and erased
(`verbatimModuleSyntax`), which the smoke proves by compiling it.

Per-capability config (ADR-041 §6 "config hand-off"): when the capability declares a `configSchema` and the entity
supplies `config: { <Cap>: {…} }`, the repository emits

```ts
  override readonly groupConfig = { … } as const;
```

> Changed in CAP-3 (#629): emitted **public** `override readonly`, not `protected override readonly`. A mixin
> shipped in `runtime/` must declare its surface through an interface (TS4094 under declaration emit), which
> cannot carry `protected`. A public override still fills a consumer mixin's `protected` declaration.

using the same `renderPatternConfigLiteral` the spine's `patternConfig` uses. `configProperty` defaults to
`<camelCase(name)>Config`. `override` requires the mixin to declare the property — that is the contract (§4), and a
mixin that doesn't is a consumer `tsc` error at the generated file, not a silent drop. Capability config is emitted
on the **repository only**; the mixins live there.

Service forwarders (`service.ejs.t`), after the `queries:` pass-throughs:

```ts
  members(...args: Parameters<AccountRepository['members']>): ReturnType<AccountRepository['members']> {
    return this.repository.members(...args);
  }
```

Non-`async` (§M8). No signature is re-declared anywhere (I1).

`mixinImport` goes through `rewriteSharedImport(runtimeMode, …)` exactly like `repositoryImport`: a library
capability authored as `@shared/base-classes/with-actor` becomes `@pattern-stack/codegen/runtime/base-classes/with-actor`
in package mode; an app capability's alias passes through untouched. No library capability ships in CAP-1, so this
path is unit-tested rather than smoked (CAP-3 smokes it).

### 6. Packaging

`src/patterns/compose.ts` is imported by the hygen template, so it must ship: it is added to the `files` manifest
next to `registry.ts` and `pattern-definition.ts`. A missing entry here is the #266 class (works from checkout,
broken from tarball) and `just test-post-publish` is not in `just test-all`, so a unit test walks every
`src/…` specifier reachable from `templates/**` and asserts the `files` globs cover it.

### 7. The regression guard — `just test-smoke-capability`

ADR-041's "Testing / safety" requires a 3-capability fixture that compiles against the real bases. Two legs, one
harness (`test/smoke/run-smoke-capability.ts`), in `just test-all` → CI:

- **vendored leg** — `project init --runtime vendored`; capability mixins import `@shared/base-classes/…`.
- **package leg** — `project init --runtime package`; the generated tree imports
  `@pattern-stack/codegen/runtime/*`, aliased by tsconfig `paths` to the in-repo `runtime/` sources (the
  `test/smoke-integration/run.ts` precedent).

Both legs author a realistic consumer surface into the tmp project — three `kind: 'capability'` app patterns under
`src/patterns/*.pattern.ts` (the default glob) and their mixins under `src/modules/capabilities/`, addressed as
`@modules/capabilities/…` (a `project init` alias; deliberately **not** `@shared/…`, which is reserved for the
package runtime) — then generate, assert the emitted shapes, and run `tsc --noEmit` scoped through the shared
`test/smoke/_consumer-errors.ts` by location only (I9, GATE-2).

Fixtures:

| Entity | `patterns:` | Proves |
|---|---|---|
| `account` | `[Group, Integrated, Individual, Audited, Actor]` | composed-base file · multi-layer chain · `Integrated` spine found out of position 0 · the type-only import cycle · abstract `integrationConfig` still enforced · per-capability config literal · forwarders |
| `contact` | `[Actor]` | inline `extends WithActor(BaseRepository<…>)`, no composed-base file |
| `note` | *(none)* | emission unchanged when no pattern is declared |

The table is the fixture set as it stands on the chain tip (corrected by REV-0, #688): CAP-3 appended the library
`Actor` to `account` and made it `contact`'s one capability; CAP-2/CAP-3 added `meeting`, `person`, `crew`, `squad`,
`shift` and the junction/relationship fixtures, documented in their own specs.

The positional spine rule this spec removed from the hygen locals also survived in the integration emitter
(`adapter-emission-generator.ts`, the assembly/sink gate). REV-0 (#688) routes it through `composePatterns(...)
.spineName`; the regression test is the `patterns: [Actor, Integrated]` + `surface:` case in
`src/__tests__/cli/adapter-emission-generator.test.ts` (the smoke fixtures declare no `surface:`).

Plus two **negative** gates (CAP-2 added `role-target-not-actor` and `roles-without-communication`) run through the CLI: a two-spine entity (`[Integrated, Activity]`) and a
capability-vs-`queries:` method collision must each fail `entity new` with a non-zero exit and the expected message.

## Out of scope

- The `clean` backend pipeline (ADR-041 §6 defers it; #602).
- Library capability patterns. ADR-041 §5 ships `Group`/`Individual`; PLAN §6.4 supersedes them with
  `Actor`/`Communication` in CAP-3. Building the ADR's placeholders now would ship something CAP-3 deletes, so CAP-1
  ships the *mechanism* plus fixture capabilities that live in the smoke's tmp project.
- The "delegate capability receives config at construction" variant of ADR-041 §6. Forwarders forward to the
  composed **repository**; no consumer needs an injected delegate, and inventing the DI shape for one is
  speculative (ADR-041 §5's own posture).
- Anything in the frontend emitter, the relations manifest, or CGP-358b service composition.

## Found during implementation

1. **M1 is the finding that matters, and it is good news.** The design was written expecting to have to work around
   TypeScript's mixin/`protected` limitation. It does not apply: `this.col(...)`, `this.baseQuery(...)` and the rest
   of the post-REL-0 `protected` surface resolve inside `abstract class M extends TBase`. CAP-3's `WithActor` /
   `WithCommunication` can therefore build a scoped predicate through the repository's own `scopeAnd()` choke point
   (charter I3) instead of taking a scope argument or casting `this`.

2. **`EntityOf` had to widen, and the failure was invisible until a *generated* class existed.** The first version
   returned `never` on a non-match and passed every direct test of the mixin itself; it fails only where a class
   extends the mixin, because the checker instantiates the base type parameter as `any` (§M4, TS2417). A spike that
   only writes mixins — as ADR-041's did — cannot see this. It is the concrete reason the fixture has to compile
   *generated* code, not model it.

3. **The spine expression moved from the template into JS, and that is what makes "no capability ⇒ no diff"
   checkable.** `repository.ejs.t` had the two forms (two-argument inline, four-argument multi-line) as EJS branches.
   Building both in `prompt-extension.js` means one place asserts the byte-identical strings, and the unit test can
   assert them directly. Evidence it held: the junction snapshots and the baseline are unmoved by this PR.

4. **A capability's `config:` block goes inside the `entity:` block**, next to `pattern:` — `config` is not a
   top-level key (`EntityDefinitionSchema`), and the first draft of the fixtures put it at the root and was rejected
   by the schema. The locals builder reads both shapes; the schema accepts one.

5. **`VENDORED_RUNTIME_FILES` needed the new contract.** A vendored consumer's capability mixin imports
   `@shared/base-classes/capability-mixin`, which resolves only if `project init` vendors it. Caught by the vendored
   leg of the new smoke, which is precisely why both legs exist.

6. **Three existing unit tests asserted the behaviour ADR-041 deletes** and were rewritten, not deleted: the two
   `patterns[0]`-wins cases in `prompt-extension.test.ts` and the `Activity + Integrated` composition block in
   `validate-composition.test.ts` now pin the hard error. Two further cases (implied-behaviour dedup, opaque
   method-name conflicts) had fixtures that happened to use *two* domain patterns; they were re-based on one spine
   plus one capability, which is the shape those rules live in now.

7. **`src/patterns/compose.ts` is the fourth `src/` module the templates import, and the manifest is hand-maintained.**
   `just test-post-publish` would have caught a missing entry, but it is not in `just test-all` — so the PR adds
   `src/__tests__/templates/template-src-imports.test.ts`, which walks the template → `src/` import graph
   transitively and asserts the `files` globs cover every module reached. Verified to bite: removing the new entry
   fails it. (JSDoc `import('…')` type references are stripped first — they are erased and never loaded.)

8. **`PLAN.md` / `PROJECT.md` were deliberately not edited here**, for REL-0's reason: the checkpoint-1 revisions are
   in unmerged PR #606 and this branch carries the pre-checkpoint copies. PLAN §6.4's proposed CAP-3 fixture
   (`patterns: [Integrated, Activity, Communication]`) is now a hard error and needs revising once #606 lands — it is
   called out in "What downstream must know" and in the epic #582 log entry.

## Acceptance — all met

Output from the run made **after the last edit** (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | **exit 0** |
| `just test-all` | **exit 0** — typecheck · unit **3225 pass / 0 fail** · baseline · smoke · smoke-subsystems (vendored + package) · smoke-relationship · smoke-junction · smoke-junction-cross-domain · **smoke-capability (vendored + package)** · junction snapshots 10/10 · integration-emit 56/56 · smoke-integration |
| `just test-integration` | **exit 0** — 64 pass · 2 skip (pre-existing `test.skip` in `bridge-e2e.test.ts`) · 0 fail |
| `just test-smoke` | **exit 0** — run separately because `runtime/base-classes/**` changed (charter I9) |
| `just test-post-publish` | **exit 0** — tarball contract + full consumer workflow from the tarball; proves `src/patterns/compose.ts` actually ships |
| `just test-smoke-junction-clean` | exit 1 — **known-red, #602**, still exactly **118**; not repaired, not filtered |

- **No snapshot moved.** The baseline (`clean` pipeline) and all 10 junction snapshots are byte-identical: an entity
  that declares no capability emits exactly what it emitted before.
- **No filters, no carve-outs, no new gate outside CI.** `just test-smoke-capability` is in `just test-all`, which is
  what the CI `test-all` job runs. Its `tsc` output is scoped through the shared `test/smoke/_consumer-errors.ts`, by
  location only.
- **New `any`s: three occurrences in two type declarations**, all in `runtime/base-classes/capability-mixin.ts` —
  the mixin rest parameter (`(...args: any[])`, twice) and the entity slot of the constructor constraint. Each is
  measured as unavoidable (§M2, §M3: `never[]` is TS2545, `unknown`/`never` in the entity slot rejects a concrete
  repository) and each is the idiom the shipped `WithAnalytics` already carries; two `eslint-disable-next-line`
  comments, no blanket disable. No `as unknown as` introduced anywhere, and none in generated code.

## Risks — outcome

- **A throw inside the hygen subprocess does not fail the CLI.** Did not happen — both negative gates exit non-zero
  and the message reaches stderr. Now permanently gated by the smoke rather than assumed.
- **The type-only import cycle breaks.** Did not happen; it compiles in both runtime modes.
- **A capability mixin cannot reach a `protected` base member.** Did not happen (§M1) — this was the risk that would
  have forced a redesign.

| Risk | Signal | Response |
|---|---|---|
| `EntityOf` / `TableOf` break on a TS or drizzle bump | `tsc` errors inside a capability mixin, or TS2417 on a generated composed base | A15–A17; `just test-smoke-capability` is the detector. Do **not** "fix" it by widening a capability method's return to `unknown` |
| A capability's mixin omits a `configProperty` the entity configures | TS4114 in the generated repository | the mixin declares the property — that is the §4 contract; do not drop the `override` |
| A capability vocabulary grows beyond a handful of names | `forwarderMethods` becomes a maintenance list | ADR-041 §3's stated trade: `forwarderMethods` is viable only for small, known vocabularies. A large one wants a different mechanism, not a longer list |
| CAP-3 lands `Activity` as a capability and the two spine rules interact | a `[Integrated, Activity, Communication]` entity | decide in CAP-3 whether `Activity` becomes a capability or the fixture takes a different spine; the error message already names the choice |

## A-checklist additions (carry into the next RC / TS bump)

| # | Surface | Shape we depend on | Where it bites |
|---|---|---|---|
| A15 | TS mixin rules | a mixin base constraint must be `(...args: any[])` (TS2545), and the static-side check instantiates the base type parameter as `any` | `runtime/base-classes/capability-mixin.ts` §M2/§M4 |
| A16 | `protected` access through a generic mixin base | allowed — `this.col` / `this.baseQuery` resolve inside `abstract class M extends TBase` | every capability mixin (CAP-3) |
| A17 | instantiation expressions in an `extends` clause | `Cap(Spine<TEntity, typeof table>)` resolves, inline and inside a generated `abstract class … extends` | `repositoryExtendsClause`, `<Entity>ComposedBase` |

## What downstream must know

**How a capability is declared.** `kind: 'capability'` on a pattern definition — library
(`src/patterns/library/*.pattern.ts`, via `defineCapabilityPattern()`) or app
(`src/patterns/*.pattern.ts`, the default glob). Fields: `mixin` + `mixinImport` (both or neither),
`forwarderMethods`, `configProperty`, `configSchema`, `columns`, `impliedBehaviors`. It must **not** carry
`repositoryClass` / `serviceClass` — registration rejects that. Contribution minimum: columns, a mixin, or
forwarder methods.

**How a capability mixin is written.** Against `runtime/base-classes/capability-mixin.ts` —
`RepositoryCtor`, `EntityOf<TBase>`, `TableOf<TBase>`, exported from the base-classes barrel and vendored to
`@shared/base-classes/capability-mixin`. The shape that works is in that module's doc comment. Do not narrow
`RepositoryCtor`, and do not make `EntityOf` fall back to `never` (§M3/§M4). A mixin **may** use the repository's
`protected` surface — `this.table`, `this.tableRef`, `this.col()`, `this.baseQuery()`, `this.scopeAnd()` (§M1) — and
it **must** get its tenant scope that way rather than taking a parameter (charter I3).

**How config reaches the mixin.** The entity's `config: { <Capability>: {...} }` block (inside the `entity:` block)
is emitted on the generated **repository** as `override readonly <configProperty> = {...} as const` (public —
changed in CAP-3 (#629) from `protected override readonly`; see `docs/specs/CAP-3.md` Found #1),
defaulting to `<camelCase(name)>Config`. The mixin declares that property — optional (`?`) or abstract — and reads it
at runtime. Nothing is emitted on the service, and nothing is passed to a constructor.

**How forwarders are emitted on the service.** One non-`async` method per `forwarderMethods` entry:
`m(...args: Parameters<<Entity>Repository['m']>): ReturnType<<Entity>Repository['m']> { return this.repository.m(...args); }`.
The capability declares only the **name**; the signature comes from the repository method the mixin contributed. A
forwarder naming a method the composed repository does not have is a consumer `tsc` error (TS2339), by design.

**Spine rules CAP-2 / CAP-3 must design against.**
- Exactly one declared domain pattern may contribute a repository/service class. Two is a **hard error** at
  generation *and* at validation (`pattern_multiple_spines`).
- **`patterns: [Integrated, Activity]` is now an error.** PLAN §6.4's proposed CAP-3 fixture
  `patterns: [Integrated, Activity, Communication]` therefore does not generate. CAP-3 must either author `Activity`
  as a capability (which ADR-041 §5 anticipated) or give the fixture a single spine. This is the one decision CAP-1
  hands forward.
- Position does not matter. `patterns: [Actor, Integrated]` and `[Integrated, Actor]` emit the same base; declaration
  order controls only **mixin nesting** (rightmost outermost).

**Collision rules.** `forwarderMethods` are checked against each other, the emitted `queries:` methods and the
relationship forwarders, at generation time. A capability that wants to *replace* a generated method name cannot —
rename one of them. Methods a capability does not declare stay invisible to codegen and surface as consumer compile
errors.

**Emission artifacts a later unit may need to touch.**
- `<entity>.composed-base.ts` — new `@generated` file, `clpOutputPaths.composedBase`, emitted only at ≥2
  capabilities. It is **not** in the module barrel (`index.ts`); add it there only if something outside the module
  needs the type.
- `repositoryExtendsClause` / `composedBaseExtendsClause` are built in `prompt-extension.js`, not in the template.
  Any future change to the repository's type arguments (REL-2's typed includes, for instance) edits `spineTypeArgs`
  in one place and both shapes follow.
- `composePatterns()` / `detectMethodCollisions()` (`src/patterns/compose.ts`, exported from the package barrel) are
  the single implementation of the spine rule. CAP-2's `roles:` validation ("`roles:` without `Communication`" and
  vice versa) belongs next to it, not in a second partition of the pattern list.

## Open questions

None. ADR-041's open follow-up #3 is answered in §2 and in the ADR's revision note; follow-ups #1 and #2 belong to
CAP-3 and are now unblocked.
