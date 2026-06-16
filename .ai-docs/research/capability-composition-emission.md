---
slug: capability-composition-emission
linear: null
status: research
date: 2026-06-15
related: [subject-lattice-codegen-lift, ADR-031, ADR-032, ADR-041]
---

# Understanding: how should codegen-patterns emit a single repository/service that carries the behaviour of MULTIPLE composed patterns, given TypeScript single-inheritance?

## Request

The ADR-031 app-defined-patterns system already supports multi-pattern composition at the YAML + validator layer (`patterns: [A, B]`; `src/patterns/validate-composition.ts:49-182` unions implied behaviors and hard-errors on column conflicts). But **emission picks exactly one base class** — the clean-lite-ps resolver takes the base from `patterns[0]` and silently drops every later pattern's `repositoryClass`/`serviceClass`/methods (`templates/entity/new/clean-lite-ps/prompt-extension.js:86-107`). So `patterns: [Integrated, Group, Individual]` validates but cannot emit all three capabilities' methods onto one repository/service. TypeScript single-inheritance is the wall.

This research characterises that limitation precisely across **both** backend pipelines, traces exactly where the second pattern's contributions drop, surveys the composition-emission mechanisms (generated composed-base / TS mixins / config-driven delegate / hybrid) against this repo's actual machinery, and recommends a direction concrete enough to write an ADR from. It does **not** decide the ADR — it lays out the options and the decisions the ADR must make.

## Motivation

ADR-0022's "both, layered" ruling (a subject entity that is `Integrated` *and* a `Group` *and/or* `Individual`) forces this question, but the limitation is **general** to the patterns system, not specific to the subject lattice. Any consumer wanting two capabilities' generated methods on one entity hits it. The prior research (`subject-lattice-codegen-lift.md:50-72`) flagged this as the single biggest design risk gating the whole lift; this artifact is the dedicated decision-prep for that risk so the lift (and any other multi-capability consumer) can proceed.

---

## Current emission trace — where the methods drop, and what data is available

### How a pattern represents its capability (the crux)

A `PatternDefinition` (`src/patterns/pattern-definition.ts:54-119`) carries the base class as a **string constructor name + import path**, never the class itself:

```ts
// src/patterns/pattern-definition.ts:74-96
repositoryClass?: string;   // "Constructor name codegen emits in the extends clause"
serviceClass?: string;
repositoryImport?: string;  // path alias the consumer's tsconfig resolves
serviceImport?: string;
repositoryInheritedMethods?: string[];  // "Documentation-only method-signature strings emitted as comments"
serviceInheritedMethods?: string[];
columns?: PatternColumnContribution[];
impliedBehaviors?: string[];
configSchema?: ZodSchema<TConfig>;
```

The doc comment at `:8-11` is explicit about *why* it is a string: `definePattern()` "carries only names + import paths for the classes a generated entity should extend — never the class constructors themselves. This keeps the codegen pipeline free of TS class-evaluation cost and avoids `reflect-metadata`, which lets the Hygen subprocess cheaply rebuild the registry." ADR-031 Alternative 2 (`docs/adrs/ADR-031-app-defined-patterns.md:223-227`) rejected TS-class patterns for the same reason.

**Load-bearing consequence:** the generator does **not** and **cannot** see a pattern's actual methods. `repositoryInheritedMethods` is a free-text comma-joined string emitted as `// comment` lines (see `repository.ejs.t:234-237`), not a structured method list. The real methods live in the opaque runtime base class (e.g. `IntegratedEntityRepository.findByExternalId`, `runtime/base-classes/integrated-entity-repository.ts:33`). The generator knows a pattern's *name, import, columns, behaviors, configSchema* — it does **not** know its method set as machine-readable data. **This single fact constrains every strategy below** (see §Strategy A feasibility).

### Pipeline 1 — clean-lite-ps (the only pipeline that consumes patterns today)

The base class is resolved in `resolvePatternBaseClasses` (`templates/entity/new/clean-lite-ps/prompt-extension.js:86-107`):

```js
// prompt-extension.js:86-107
export function resolvePatternBaseClasses(entity) {
  const name =
    (typeof entity.pattern === 'string' && entity.pattern) ||
    (Array.isArray(entity.patterns) && entity.patterns[0]) ||   // <- only [0]
    'Base';
  const def = getPattern(name) || getPattern('Base');
  ...
  return {
    patternName: def.name,
    repositoryBaseClass: def.repositoryClass,   // single string
    serviceBaseClass: def.serviceClass,         // single string
    repositoryBaseImport: def.repositoryImport,
    serviceBaseImport: def.serviceImport,
    repositoryInheritedMethods: def.repositoryInheritedMethods ?? [],
    serviceInheritedMethods: def.serviceInheritedMethods ?? [],
  };
}
```

The doc comment at `:76-82` states the drop in plain words: *"`entity.patterns[0]` … the first name drives the base-class choice. Subsequent patterns contribute columns + implied behaviors … but do not change the template's repository/service base class."*

The single resolved name lands in the templates verbatim:

- **Repository** (`templates/entity/new/clean-lite-ps/repository.ejs.t:26,76,82,234`):
  ```ejs
  import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
  ...
  export class <%= classNames.repository %> extends <%= repositoryBaseClass %><<%= classNames.entity %>> {
  ...
  // Inherited from <%= repositoryBaseClass %>:
  <%_ repositoryInheritedMethods.forEach(line => { _%>  //   <%= line %>
  ```
- **Service** (`templates/entity/new/clean-lite-ps/service.ejs.t:10,39-41`):
  ```ejs
  import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
  ...
  export class <%= classNames.service %> extends WithAnalytics(
    <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
  ) {
  ```

**Where exactly the second pattern dies:** at `prompt-extension.js:89` (`entity.patterns[0]`). Patterns `[1..n]` are read *only* by `resolveImpliedBehaviors` (`prompt-extension.js:122-139`, unions `impliedBehaviors`) and by the column-conflict validator. Their `repositoryClass`/`serviceClass`/`*Import`/`*InheritedMethods` are never read. **The full pattern set IS available at this point** — `entity.patterns` is the whole array and `getPattern(name)` resolves each — so a different emission strategy *could* see all contributions. Nothing upstream discards them; the resolver simply indexes `[0]`.

**Already-present mixin precedent:** the service template (`service.ejs.t:39`) ALREADY wraps the base in a mixin application — `extends WithAnalytics(ServiceBase<...>)`. `WithAnalytics` is a real TS mixin (`runtime/base-classes/with-analytics.ts:17-22`, `function WithAnalytics<TBase extends Constructor>(Base)`). So **emitting `extends Mixin(Base<...>)` is a shipped, tested pattern in this pipeline** — strategy B is not greenfield syntax.

### Pipeline 2 — full clean (`templates/entity/new/backend/`, the default)

**The clean pipeline does not consume patterns AT ALL.** Findings:

1. `prompt.js` only computes pattern-derived locals (`repositoryBaseClass`, etc.) inside the `isCleanLitePs` branch (`prompt.js:1643-1651`). In the `clean` branch it injects empty stubs (`prompt.js:1672-1677`): `repositoryBaseClass: ''`, `serviceBaseClass: ''`, `patternName: 'Base'`, `hasPatternConfig: false`. The pattern registry (`ensurePatternsRegistryLoaded`) is loaded only for clean-lite-ps (`prompt.js:1649`).
2. The clean repository template hardcodes its base: `extends BaseRepository<typeof <%= plural %>, ...>` (`templates/entity/new/backend/database/repository.ejs.t:28-36`). No `repositoryBaseClass` local — `BaseRepository` is a literal in the template.
3. **There is no service-class template in the clean pipeline at all.** `Grep` for `extends (BaseService|...)` under `templates/entity/new/backend/` returns nothing. The clean pipeline is command/query-per-operation (`BaseFindByIdUseCase`/`BaseListUseCase`, `runtime/base-classes/base-read-use-cases.ts`), not a single service class.
4. The composition validator emits a `pattern_clean_pipeline_noop` **warning** for any entity declaring `pattern:` under `architecture: clean` (`src/patterns/validate-composition.ts:209-233`).

**So the limitation is asymmetric, not uniform:**

| | clean-lite-ps | clean (default) |
|---|---|---|
| Consumes patterns? | Yes | **No** (no-op warning) |
| Base-class selection | `patterns[0]` → single base (the drop) | Hardcoded `BaseRepository`; no service class |
| Multi-capability gap | Present — drops `patterns[1..n]` | Present in a deeper sense — **no pattern emission to extend** |

The clean pipeline is *worse*: it has no capability-composition machinery to fix, only an empty seam. Any composition-emission mechanism that targets clean-lite-ps would need a from-scratch port to clean (likely out of scope — ADR-031 `:213` defers clean-pipeline pattern support to "additive Phase 3+"). **The decision below should scope to clean-lite-ps and treat clean as explicitly deferred.**

### What the chosen base class actually requires of the concrete class

Each library base carries its own *required config contract*, which matters for composition (you can't naively stack two bases that each demand a different abstract member):

- `IntegratedEntityRepository` (`runtime/base-classes/integrated-entity-repository.ts:19-28`): `protected abstract readonly integrationConfig: IntegrationUpsertConfig` — concrete repo MUST supply it (emitted from `clpIntegrationConfig`, `repository.ejs.t:107-118`).
- `ActivityEntityRepository` (`runtime/base-classes/activity-entity-repository.ts:36-69`): reads `protected readonly patternConfig?: ActivityPatternConfig`; subject finders throw if absent (emitted from `config:` via `renderPatternConfigLiteral`, `repository.ejs.t:94-101`).

Both also extend `BaseRepository` (diamond root). A composed base must satisfy *every* composed pattern's abstract members and config hand-off, and resolve the shared `BaseRepository` root once.

---

## Strategy survey — evaluated against this repo's machinery

### (A) Generated composed-base — codegen synthesizes one base class per entity that flattens all patterns' methods

**How it would work here:** for `patterns: [Integrated, Group]`, codegen emits a new file `<entity>.composed-base.ts` defining `class OpportunityComposedBase extends ??? { ... }` that exposes the union of both patterns' methods, and the concrete repo extends *that*.

**FEASIBILITY KILL for the literal "flatten the methods" form:** the generator has **no machine-readable view of a pattern's methods** (see trace above — `repositoryInheritedMethods` is a doc-comment string; the real methods live in opaque runtime classes referenced only by name + import). Codegen **cannot mechanically merge method bodies it cannot see.** To "flatten methods of all composed patterns into one emitted class," codegen would need either (a) the pattern to expose its methods as structured, emittable units (it does not — `PatternDefinition` has no method-body field, by deliberate design to avoid TS-class evaluation, `pattern-definition.ts:8-11`), or (b) to read and parse the runtime base-class source — a non-starter (brittle AST surgery, breaks the package/vendored import model).

**What IS feasible — generated composed-base via mixin *application*, not method-flattening:** codegen can emit a base file that *applies* the patterns as mixins/extends-chains without seeing their bodies:
```ts
// opportunity.composed-base.ts  (generated)
export abstract class OpportunityComposedBase
  extends GroupCapability(IntegratedEntityRepository<...>) {}
```
This collapses to **strategy B's mechanism** (mixins) with a generated wrapper file. The "codegen owns emission so it can merge what hand-written TS can't" advantage is real, but the *thing being merged* is mixin applications, not method bodies — codegen's leverage is that it can compute the correct nesting order and config hand-off, not that it can see inside the bases.

**Cost / interactions:** an extra generated file per multi-pattern entity; the concrete repo `extends <Entity>ComposedBase`. Column union + behavior union already work (validator). Method-name collisions: **invisible to codegen** (it can't see the methods) → surface as TS errors at consumer compile, exactly as the validator already documents (`validate-composition.ts:17-20`: "Method-name conflicts … surface as TypeScript compile errors"). NestJS DI: the composed base is still a single `@Injectable()` concrete class — no `multi:true` problem. **Verdict: viable only as a thin generated wrapper over strategy B; the "flatten methods" framing is infeasible given opaque bases.**

### (B) TS mixins — `Capability(Base)` mixin application, emitted by codegen

**How it would work here:** each composable capability ships as a mixin function `Group<TBase extends Constructor>(Base: TBase)` in `runtime/base-classes/`, exactly like `WithAnalytics` (`with-analytics.ts:17-22`). Codegen emits the nested application in the `extends` clause: `extends Group(Integrated(BaseRepository<...>))` (or via a generated composed-base file, = hybrid with A). One pattern remains the "spine" base (`patterns[0]`), the rest are mixins.

**This is the lowest-syntax-risk option because the pipeline already does it.** `service.ejs.t:39` ships `extends WithAnalytics(<%= serviceBaseClass %><...>)` today, compiled and smoke-tested. Extending the resolver to emit `repositoryMixins: string[]` + `repositoryBaseClass` (spine) is a localized change to `resolvePatternBaseClasses` (`prompt-extension.js:86-107`) + the two `extends` lines in `repository.ejs.t:76/82` and `service.ejs.t:39`.

**Costs / friction:**
- **Typing.** Mixins return intersection types; deep nesting (`A(B(C(Base)))`) is known to strain TS inference and can produce "type instantiation is excessively deep" with generics. The base classes here are generic (`IntegratedEntityRepository<TEntity, TWrite, TProjection>`) — nesting generic mixins needs care. The existing `WithAnalytics` wraps only a single generic base; 3-deep generic nesting is untested here.
- **NestJS DI + decorator metadata.** `@Injectable()` is on the concrete class (`repository.ejs.t:74`), not the mixins — fine. But mixin-injected dependencies (e.g. a capability needing its own injected service) can't be constructor-injected through a mixin cleanly without property injection (`@Inject()` on a property, the `WithAnalytics` model — `with-analytics.ts` doc `:11`). Capabilities that need constructor deps would force constructor-signature coordination across the mixin chain — friction. The Activity/Integrated config-hand-off model (property `patternConfig`/`integrationConfig`, not constructor args) sidesteps this and is the safer shape for capabilities.
- **Abstract-member satisfaction.** If two stacked bases each declare an abstract member, the concrete class must satisfy both — codegen already emits `integrationConfig` and `patternConfig`; a second capability's abstract member would need its own emit hook.
- **Collision policy.** Same as A — method-name collisions surface as TS errors (the validator's documented stance).

**Verdict: the strongest *mechanism* (proven in-repo), with the generated-composed-base wrapper (A) as the readable packaging. Main risk is generic-mixin typing depth.**

### (C) Config-driven delegate — capabilities as injected/configured delegates, not inheritance (the Activity model generalized)

**What the Activity model actually is (read in full):** `ActivityEntityRepository` (`runtime/base-classes/activity-entity-repository.ts:36-109`) is **NOT a delegate** — it is a config-driven **base class**. Its methods (`findBySubjectId`, etc.) live *on the inherited base*; `patternConfig` only *parameterizes* which column they read (`subjectColumn` getter at `:59-69`). `ActivityEntityService` (`activity-entity-service.ts:19-50`) likewise has the methods on the base and forwards to the repo. So today's "config-driven" pattern is **single-inheritance + runtime config**, not delegation. It does NOT compose two capabilities — it configures one base.

**A true delegate generalization would be:** the concrete repo/service news-up (or injects) a `GroupCapability` helper from `config:`/role-map and exposes its methods by *forwarding*. Methods would be *typed* only if codegen emits explicit forwarder methods (`async members(id) { return this.groupCapability.members(id); }`) — which is exactly how the `queries:` block already emits service pass-throughs (`service.ejs.t:94-99`) and how CGP-358b relationship composition emits forwarders (`service.ejs.t:120-147`). So the **precedent for typed delegation already exists in the service template.**

**Costs / interactions:**
- **Typed surface requires emitted forwarders.** A delegate gives you runtime behaviour for free but a *typed* method surface only if codegen emits one forwarder per capability method — and codegen doesn't know the method list (opaque base problem again). So either the capability exposes a *fixed, known* method set the template hardcodes forwarders for (like Activity's 4 finders), or the surface is untyped (`this.groupCapability.members(...)` reachable only by knowing the delegate). For a *known, small* capability vocab (the lattice's `members()`/`toShape()`), hardcoded forwarders are tractable — this is the Activity precedent extended.
- **Discoverability.** Delegated methods don't appear on the class unless forwarded; less discoverable than inherited/mixed methods.
- **Sidesteps single-inheritance entirely** — the killer advantage. A concrete repo can hold N delegate capabilities with zero inheritance-chain conflict, zero diamond, zero generic-mixin-depth risk. DI is clean: each delegate is an `@Injectable()` or a config-newed helper.
- **No abstract-member collision, no constructor-chain coordination.** Each delegate manages its own config.

**Verdict: the safest mechanism for *new* capabilities whose method vocab is small and codegen-known (lattice `members`/`toShape`). Weaker for wrapping *existing* opaque bases (`Integrated`) as delegates — you'd still inherit one and delegate the rest.**

### Hybrid — one inherited spine base + others as delegates/mixins

**The shape the evidence points to:** keep `patterns[0]` (or a designated spine) as the inherited base (preserves the Integrated/Activity config-hand-off and the existing `extends <%= repositoryBaseClass %>` line), and compose `patterns[1..n]` as **either** mixins (B, when the capability is a mixin function) **or** typed delegates (C, when the capability has a small known method vocab emitted as forwarders). This matches how the service template *already* layers: `extends WithAnalytics(Base<...>)` (mixin) + `queries:`/CGP-358b forwarders (delegate-style) on the same class.

This is almost certainly the realistic answer because: (1) existing opaque bases like `Integrated` can only be *inherited* (can't be mechanically merged or delegated without a forwarder list codegen doesn't have); (2) new capabilities like `Group`/`Individual` can be authored as mixins or small-vocab delegates from day one. So the ADR likely ratifies: **spine = the one pattern with an abstract-config base (Integrated/Activity); capabilities = mixins or forwarder-delegates layered on top.**

---

## Interaction with the rest of the system

- **`queries:` emission** composes cleanly on top of any strategy — it appends methods to the concrete class body (`repository.ejs.t:146-172`, `service.ejs.t:94-99`) and registers query classes in the module (`prompt-extension.js` module locals). It does not touch the `extends` clause, so it is orthogonal. A composed capability that emits a method of the same name as a query *would* collide — collision policy (below) must cover capability-vs-query, not just capability-vs-capability.
- **Runtime base-classes (`runtime/base-classes/`)** — strategy B adds mixin-function capabilities here (the `WithAnalytics` neighbourhood, `index.ts:60`); strategy C adds `@Injectable()` delegate helpers; both are package-published + vendored (the `runtimeImport`/`subsystemsImport` machinery in `prompt.js:1407-1417`). Import-specifier wiring already exists for base classes (`prompt-extension.js` rewrites via `rewriteSharedImport`).
- **Baseline snapshot tests** — CLAUDE.md + memory `project_baseline_clean_arch_only`: baseline covers **clean-arch only**, which does NOT consume patterns. So baseline will NOT catch composition-emission changes. Coverage must come from **clean-lite-ps template-emission tests** (memory) + the smoke/tsc gate.
- **Smoke / tsc gate** — this is the real safety net. Composed bases must `tsc`-compile in the smoke project (`just test-smoke` / `just test-smoke-integration`, memory `feedback_smoke_integration_gate`). The generic-mixin-depth risk (B) and the abstract-member-satisfaction risk surface *here*, not in unit tests. Any strategy MUST add a multi-pattern fixture to the smoke harness.
- **Blast radius (smallest first):** (C) typed-delegate forwarders for a *new* small-vocab capability is the most contained — touches only new runtime helpers + new template forwarder blocks, leaves `extends <%= repositoryBaseClass %>` untouched. (B) mixins touch the `extends` line + resolver but reuse the shipped `WithAnalytics` mechanism. (A) literal method-flattening is infeasible (opaque bases). The clean pipeline is out of scope under every option.

---

## Recommendation

**Adopt a hybrid: one inherited spine base + capabilities composed as TS mixins (the `WithAnalytics` mechanism), with a generated per-entity composed-base file as the readable packaging when ≥2 mixins stack.** For *new* lattice capabilities (`Group`/`Individual`) whose method vocab is small and codegen-known, prefer the **typed-delegate-forwarder** shape (strategy C, the Activity/`queries:` precedent) — it sidesteps single-inheritance entirely and is the most contained.

**One-line why:** mixin application is already shipped and tsc-gated in this exact pipeline (`service.ejs.t:39` `extends WithAnalytics(Base<...>)`), so it is the lowest-risk path to "more than one capability's methods on one class," while a spine base preserves the Integrated/Activity abstract-config hand-off that pure delegation can't replicate for the opaque library bases.

**Three reasons it beats the alternatives:**
1. **The mechanism is proven in-emission, not theoretical** — `WithAnalytics(Base)` compiles in the smoke project today; strategy A's "flatten methods" is *infeasible* because patterns expose bases as opaque string-named imports with no machine-readable method list (`pattern-definition.ts:8-11,74-96`), so codegen literally cannot merge what it cannot see.
2. **The spine preserves the existing config-hand-off** (`integrationConfig`/`patternConfig` abstract members, `integrated-entity-repository.ts:28`, `activity-entity-repository.ts:42`) that the concrete-class emit already satisfies — pure delegation would orphan those abstract contracts.
3. **It minimizes blast radius and reuses existing precedents** — typed-delegate forwarders for new capabilities mirror the `queries:` and CGP-358b service pass-throughs already in `service.ejs.t:94-147`; no new emission paradigm.

**Single biggest feasibility risk:** **generic-mixin typing depth.** The library bases are generic (`IntegratedEntityRepository<TEntity, TWrite, TProjection>`), and `WithAnalytics` has only ever wrapped a *single* generic base. Stacking 2-3 generic mixins (`Group(Individual(Integrated<...>))`) is untested here and is exactly the class of thing that produces "type instantiation is excessively deep and possibly infinite" — which would only surface in the smoke/tsc gate, not unit tests. **A spike that tsc-compiles a 3-deep generic-mixin stack in the smoke harness should gate the ADR's acceptance.** If it fails, fall back to the typed-delegate-forwarder shape (C) for everything, accepting that opaque library bases can only be the single inherited spine. **→ Spike run 2026-06-15: PASSED on all axes — see Spike Verdict below; the delegate-only fallback is no longer forced.**

---

## Spike verdict — generic-mixin depth (VERIFIED 2026-06-15)

The gating risk above was tested with a hermetic `tsc` spike (TS **6.0.3**, the repo's compiler — `node_modules/.bin/tsc`, `strict: true`). The spike copies `WithAnalytics`/`Constructor` **verbatim** from `with-analytics.ts:15-22` and faithfully models `BaseRepository<TEntity>` + `IntegratedEntityRepository<TEntity, TWrite, TProj>` (three generics + `protected abstract readonly integrationConfig` + generic-returning `integrationUpsertOne(W): Promise<P>`), then stacks `Group`/`Individual`/`Analytics` capability mixins over it.

**All four sub-risks cleared:**

1. **No "type instantiation excessively deep".** A 4-deep stack `Group(Individual(Analytics(Integrated<E,W,P>)))` compiles in ~0.03s. A controlled depth ladder (0→4) showed zero depth-related degradation. Depth is a **non-risk** on TS 6.0.3.
2. **Generic method signatures survive the stack.** `integrationUpsertOne({externalId,name}, p)` returns `SubjectProjection` (P), not erased — and a wrong write literal `{wrong:1}` is **rejected** with TS2353, proving `TWrite` did **not** collapse to `any` through the `Constructor<T>` erasure.
3. **Abstract-member enforcement survives.** A concrete subclass omitting `integrationConfig` errors **TS2515** ("does not implement inherited abstract member integrationConfig") through the full 4-deep real-mixin stack — so codegen's emitted config stays compile-time-required; a hand-edit dropping it is caught.
4. **Per-capability typed methods compose.** `membersFragment()` and the literal-preserving `toShape('email'): {shape:'email'}` are both present and typed on the leaf.

*Investigation note:* an initial `@ts-expect-error`-based spike gave a false "abstract lost" reading — a directive line-targeting artifact (two directives in one file). A directive-free re-run, plus a depth ladder and a single-variable isolation pass (16+ configs), unanimously confirm enforcement holds. Positive control: an injected `const x: string = 123` correctly errored TS2322, confirming the compiler was actually checking.

**Consequence for the ADR:** the recommended **mixin-hybrid mechanism is verified** — Open Question framing stands, but the mechanism choice is settled (not delegate-only-by-necessity). The smoke harness should still carry a real 3-deep multi-pattern fixture as a regression guard, since the spike *models* rather than *imports* the drizzle-bearing real bases.

---

## Open questions an ADR must answer

1. **Collision policy when two composed capabilities (or a capability + a `queries:` method + a relationship forwarder) emit the same method name.** Today the validator is *silent* on method-name collisions by design (`validate-composition.ts:17-20`) and lets TS catch them at consumer compile. Is that acceptable for composition, or must codegen pre-detect collisions across patterns + queries + relationships and hard-error at generation time (better DX, but requires a codegen-known method vocab per capability — which mixins/opaque-bases don't provide)?
2. **Ordering / precedence.** In `extends Group(Integrated(Base))`, last-applied wins on name clash. Does declaration order in `patterns: [...]` define mixin nesting order (and thus override precedence)? Is the order deterministic and documented?
3. **Spine selection — does `patterns[0]` keep a privileged role?** Recommendation keeps the *first abstract-config base* as the inherited spine. Must the spine be `patterns[0]`, or the first pattern with a `repositoryClass`, or explicitly designated (e.g. `spine: Integrated`)? What happens when two patterns both want to be a base (both have `repositoryClass` + abstract config, e.g. `Integrated` + `Activity`)? Today only one can be inherited — the other must become a mixin/delegate, which requires it to ALSO ship in mixin form.
4. **How does the composed base name itself + where is it emitted?** A generated `<Entity>ComposedBase` file (strategy A packaging) vs inline nested `extends` in the concrete class. File adds an artifact + import; inline keeps it in `repository.ejs.t`/`service.ejs.t` but can get unreadable at 3-deep.
5. **Migration of existing single-base patterns.** `Integrated`/`Activity` are inheritance bases today. To be composable as non-spine capabilities they must ALSO be authorable as mixins (or expose a forwarder vocab). Does the ADR require every library pattern to ship in both forms, or only new capabilities? (No-backwards-compat rule, CLAUDE.md, means we can restructure them freely.)
6. **Does this need a new pattern `kind:`?** `PatternKind` is `'domain' | 'orchestration'` (`pattern-definition.ts:47`). A composable *capability* (mixin/delegate that is never a spine base) is arguably a third shape — it has no `repositoryClass` as a base, it has a mixin import + a known method vocab. Should the ADR add `kind: 'capability'` (with a `mixinImport` / `forwarderMethods` field) distinct from `kind: 'domain'` (a spine base)? This cleanly separates "things you extend" from "things you layer."
7. **Does `Group`/`Individual` need the configSchema → `patternConfig` hand-off, and can a mixin read it?** Activity/Integrated read config via an inherited `protected readonly patternConfig`/`integrationConfig`. A *mixin* can declare a property too (`WithAnalytics` adds `analytics?`), but a *delegate* needs config passed at construction. The ADR must specify how a non-spine capability receives its per-entity config (`config:` block) — property on the mixin, or constructor arg to the delegate.
8. **Clean-pipeline scope.** Confirm clean stays explicitly out of scope (no pattern consumption today, ADR-031 `:213`), or whether the lattice forces minimum clean support. Recommendation: defer, document as a known asymmetry.

## What I could not determine from the code

- ~~**Whether a 3-deep generic-mixin stack actually tsc-compiles in this repo.**~~ **RESOLVED 2026-06-15** — yes, verified to 4-deep with generics + abstract members intact (see Spike Verdict). The remaining unknown is narrower: the spike models the bases rather than importing the real drizzle-bearing `IntegratedEntityRepository`, so a smoke-harness fixture should confirm against the published types.
- **Whether the lattice capabilities (`Group`/`Individual`) have a method vocab small enough for forwarder-delegation.** That shape lives in swe-brain ADR-0022 / the dogfood (not re-read here); the prior research (`subject-lattice-codegen-lift.md`) treats `members()`/`to_shape()` as the core vocab, which *is* small — but the exact method set is a dogfood output, not yet pinned.

## Status — decision recorded

**The ADR is written: `docs/adrs/ADR-041-capability-composition-emission.md` (Accepted 2026-06-15).** The gating generic-mixin-depth spike was run and **PASSED** (see Spike Verdict), so ADR-041 codifies the verified mixin-hybrid and settles all eight decisions: spine = config-bearing base (not positional); a new `kind: 'capability'`; generation-time collision detection for known vocabs; new-capabilities-only migration; plus the ordering / composed-base-file / config-hand-off / clean-deferred defaults.

**Next is NOT `/plan` for codegen.** Per swe-brain ADR-0022's build-dogfood-first mandate, the `Group`/`Individual` shapes are proven in the swe-brain dogfood first; the codegen implementation here is mechanical once they land. Implementation-time follow-ups (pin `forwarderMethods` vocab, the 3-capability smoke fixture, `extends?`-chain interaction) are listed in ADR-041 and are not blocking the decision.
