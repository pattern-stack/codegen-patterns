---
slug: subject-lattice-codegen-lift
linear: null
status: research
date: 2026-06-15
related: [swe-brain#ADR-0022]
---

# Understanding: forward-design the codegen-patterns framework lift of swe-brain ADR-0022 §6 (subject people⇄group lattice, role-typed edges, selectors + `to_shape` projections)

> **Scope discipline.** This is read-only forward-design research for the *eventual* framework lift described in ADR-0022 §6. ADR-0022 is **explicitly built dogfood-first in swe-brain**; nothing here is to be implemented in codegen-patterns yet. The job is to map §6's deliverables onto this repo's real seams so a downstream `/plan` can decompose the lift into PR-sized issues once the dogfood proves the shape.

## Request

swe-brain ADR-0022 (`/Users/dug/Projects/swe-brain/swe-brain/.ai-docs/decisions/ADR-0022-subject-lattice-role-edges-selectors.md`, accepted/ratified 2026-06-15) generalizes ADR-0006's subject/interaction seam into a **people⇄group lattice**:

- **`Individual`** (Person leaf) ships `to_shape(need)` + the identity shape.
- **`Group`** (Org/Account/Team/Channel) yields its members as a **Predicate fragment, not a materialized list** — so a selector over a 5,000-person org compiles to *one* composed query, never an N+1 walk.
- Each **interaction declares a role map** — `role → (target subject type, cardinality)` edges (core vocab `from/to/cc/bcc/host/invitee/attendee/about/owner`, per-interaction extensible).
- A field is **either** a scalar leaf (the F1 `FieldType` typed-slot kernel) **or** a role-edge → a **Selector** (the F3 `ChannelSelect` picker, generalized).
- `to_shape` is a **registered shape catalog contributed by ports** (same catalog-by-code seam as Find-targets / named predicates, ADR-0012), not a god-method.
- Resolution is **live at dispatch** (option B, rides ADR-0021).

§6 ("Upstream to `codegen-patterns`") asks the framework to, *from the role-map declarations*, emit: role-edge **retrieval fragments**, **selector registration** (Find-target/selector catalog), and the standard **`to_shape` projections**, all **auto-wired onto the ApplicationServices with no hand glue**; and to ship **`Individual`/`Group` as composable entity-family capabilities** "alongside `Activity`/`Integrated`", with the shape registry as a port-contribution seam. Ratified open-Q #4: `Group`-as-family-vs-axis is **"both, layered"** — a codegen-patterns family *capability* that an ADR-0006 subject *composes* (NOT a mutually-exclusive family pick).

## Motivation

ADR-0022's pitch: one primitive (casting a net over the lattice) collapses three surfaces — the composer filter value, the actuator recipient, and the watch-list subscription. The codegen lift is the **second-dogfood repeatability proof** the project exists to produce: a selector/projection primitive general enough to ship in codegen, proven by an unrelated app (swe-brain), is exactly the evidence codegen-patterns is built to generate. Concretely it removes per-interaction hand-wiring of subject-scoping/selectors/projections, the way `queries:` already removed hand-wiring of repository finders.

## The §6 deliverables (what the framework must eventually generate)

1. **`Individual` / `Group` as composable entity-family capabilities** in codegen-patterns — `Individual` ships `to_shape` + identity shape; `Group` ships fragment-retrieval over declared member relations. Must be **composable** (a subject entity that is *also* `Integrated`, *also* a `Group`), per ratified open-Q #4.
2. **A role-declaration surface in entity YAML** — the carrier for §2's role map (`role → (target subject type, cardinality)`), core vocab + per-interaction extension.
3. **Emission from those declarations** — role-edge **retrieval fragments** (§4; group membership compiles to ONE composed query / Predicate subtree, never an N+1 walk), **selector registration** (Find-target/selector catalog), and standard **`to_shape` projections**, auto-wired onto the generated ApplicationServices.
4. **A shape registry** as a port-contribution seam (same catalog-by-code seam as Find-targets / named predicates).

## Domain landscape — repo mapping (the six areas)

### Area 1 — Entity-family seam: composable patterns, but single-base emission

**The families are no longer a mutually-exclusive `family:` pick.** ADR-005's closed `family:` enum was *superseded* by ADR-031's **app-defined patterns** (`docs/adrs/ADR-031-app-defined-patterns.md`; vocabulary note `:10` records the `sync→integration` rename). The library ships five patterns — `Base`/`Integrated`/`Activity`/`Knowledge`/`Metadata` — each a `definePattern({...})` metadata record:

- `src/patterns/library/integrated.pattern.ts:17-35` — `IntegratedPattern`: `repositoryClass: 'IntegratedEntityRepository'`, `serviceClass`, import aliases, `impliedBehaviors: ['external_id_tracking']`.
- `src/patterns/library/activity.pattern.ts:44-62` — `ActivityPattern`: `extends: ['Base']`, a `configSchema` (`subject`/`subjectColumn`/`occurredAt`) read via `this.patternConfig` at runtime, generic subject-scoped finders (`findBySubjectId`/`findRecentBySubjectId`). **This is the closest existing analog to a `Group`/`Individual` capability** — a config-driven, subject-aware base whose per-entity facts (which FK column is the subject) come from YAML `config:`.

The `PatternDefinition` surface (`src/patterns/pattern-definition.ts:54-119`) carries: `name`, `extends?`, `repositoryClass?`/`serviceClass?` (constructor *names*, never the classes — `:8-11`, `:74-78`), `repositoryImport?`/`serviceImport?`, `columns?` (`PatternColumnContribution`, `:35-40`), `impliedBehaviors?`, `configSchema?` (Zod, validates the per-entity `config:` block). Registration: `src/patterns/registry.ts` — `LIBRARY_PATTERNS` (seeded by the library barrel, `:44`), `APP_PATTERNS` (consumer globs, `:45`), `getPattern()` (`:151-153`).

**The YAML surface already supports composition.** `EntityConfigSchema` (`src/schema/entity-definition.schema.ts:490-499`) has `pattern: z.string().optional()` *and* `patterns: z.array(z.string()).optional()` (mutually exclusive, refined at `:550-552`), plus `config: z.record(...)` keyed by pattern name. ADR-031 §2 (`docs/adrs/ADR-031-app-defined-patterns.md:96-104`) documents `patterns: [CrmEntity, Event]` multi-pattern composition explicitly. The composition validator (`src/patterns/validate-composition.ts:49-182`) walks **all** declared patterns, unions `impliedBehaviors` (silent dedup, `:155-160`), and hard-errors on column-name conflicts between patterns / fields / behaviors (`:139-153`).

**THE GAP — composition is validated, not emitted (the single biggest design risk).** TypeScript has single inheritance, and the emitter honours that: the clean-lite-ps resolver picks **exactly one** base class from the **first** pattern.

```js
// templates/entity/new/clean-lite-ps/prompt-extension.js:76-82 (doc-comment)
//   2. `entity.patterns[0]` — multi-pattern case: the first name drives the
//      base-class choice. Subsequent patterns contribute columns + implied
//      behaviors (PATTERN-4 composition check) but do not change the
//      template's repository/service base class.
```

```js
// templates/entity/new/clean-lite-ps/prompt-extension.js:86-106 (resolvePatternBaseClasses)
const name =
  (typeof entity.pattern === 'string' && entity.pattern) ||
  (Array.isArray(entity.patterns) && entity.patterns[0]) ||   // <- only [0]
  'Base';
const def = getPattern(name) || getPattern('Base');
return { repositoryBaseClass: def.repositoryClass, serviceBaseClass: def.serviceClass, ... };
```

So today `patterns: [Integrated, Group]` would: validate column/behavior composition correctly, contribute `Group`'s implied behaviors, but emit a repo that extends **only `IntegratedEntityRepository`** — `Group`'s `repositoryClass`/`serviceClass`/methods would be silently dropped. ADR-0022's "both, layered" (a subject entity that is `Integrated` *and* a `Group` *and/or* `Individual`) **cannot be expressed by the current emission model**. ADR-031 itself notes the `extends` chain is single-depth in Phase 1 (`docs/adrs/ADR-031-app-defined-patterns.md:207`); true multi-capability composition is unbuilt.

This is the load-bearing finding: **the schema/validator layer is composition-ready; the emission layer is not.** The lift needs a real composition mechanism for *behavioural* contributions (methods + base capability), not just *column/behavior* contributions. Candidate shapes the planner must weigh (not decided here): TS mixins (`runtime/base-classes/with-analytics.ts` `WithAnalytics` is the existing in-repo mixin precedent — see `runtime/base-classes/index.ts:60`), a generated composed-base file (`<Entity>Base extends Mix(Integrated, Group)`), or capability-as-delegate (the base news-up a `GroupMembership` helper from `config:` rather than inheriting). The `Activity` pattern's config-driven-delegate shape (`activity.pattern.ts:44-62` reading `this.patternConfig`) is the lowest-friction precedent: `Group`/`Individual` could be **delegate capabilities driven by `config:` + the role map**, *not* base classes at all — sidestepping single-inheritance entirely. Flag for /plan.

### Area 2 — Entity YAML schema: where the role-map lands

Entity blocks live in `src/schema/entity-definition.schema.ts`; the full `EntityDefinitionSchema` is at `:830-1023`. The **declaration→generated** precedents to mirror end-to-end:

- **`queries:`** (`:571-619`, `AnyQueryDeclarationSchema` union of `QueryDeclarationSchema` + `SearchQueryDeclarationSchema`) — the canonical "declarative block → generated repo methods + interface sigs + injectable query classes + module registration". Schema → parsed (`src/analyzer/types.ts:63-70` `ParsedQuery`) → emitted (clean-lite-ps `processQueries` at `prompt-extension.js:698-745`, `processSearchQueries` at `:795`, threaded into template locals at `:1158-1208`). **This is the closest existing precedent for §6's "declaration → generated, auto-wired service surface" and the role-map block should follow its schema→parser→emitter path exactly.**
- **`integration.sink:` `SinkPolicySchema`** (`:683-689`) + its `superRefine` (`:977-1023`) — the most recent precedent for adding a per-entity declarative sub-block with **cross-field validation** (exclude_fields must be declared copy-through scalars, not FK columns, not `user_id`). The role map will need the same kind of superRefine (e.g. a role's `target` must be a known subject entity; cardinality must be `one`/`many`).
- **`relationships:`** (`RelationshipSchema`, `:364-390`; `target: z.string()`, `foreign_key`, `type: belongs_to|has_many|has_one`) — the existing typed-edge surface. **The role map is a semantic overlay on relationships**: a role-edge is a relationship *plus* a role label *plus* a target-is-a-subject assertion. The planner should decide whether roles annotate existing `relationships:` entries (e.g. `relationships.from: { ..., role: from }`) or live in a sibling `roles:` block. ADR-0022 §2 frames it as a distinct map ("Each interaction declares its role map"), favouring a sibling block.

**Proposed landing (for /plan to ratify, not a decision):** a sibling `roles:` block on `EntityDefinitionSchema`, e.g.

```yaml
roles:
  from:     { target: person,  cardinality: one }
  to:       { target: subject, cardinality: many }   # subject = lattice node (person|group)
  cc:       { target: subject, cardinality: many }
  about:    { target: subject, cardinality: one, optional: true }
```

Zod shape: `z.record(RoleNameSchema, z.object({ target: z.string(), cardinality: z.enum(['one','many']), optional: z.boolean().optional() }))` where `RoleNameSchema` is the core enum (`from/to/cc/bcc/host/invitee/attendee/about/owner`) *unioned* with a free string for per-interaction extension (mirrors how `FieldTypeSchema` is a closed enum but patterns are open). `ParsedRole` added to `src/analyzer/types.ts` alongside `ParsedQuery`/`ParsedRelationship`. Cross-validation in a `superRefine` (target resolves to a subject-capable entity) and/or in `analyzeDomain()` (`src/patterns/validate-composition.ts` is the model for analyzer-phase validation).

**Note on `entity_ref` / `allowed_types`.** The schema already has a polymorphic-reference type (`entity_ref`, `:33`, requires `allowed_types`, `:271-279`). The lattice's "target: subject (person OR group)" cardinality smells like an `entity_ref` over the subject union — the planner should check whether role-edge targets reuse `entity_ref`/`allowed_types` machinery or introduce a parallel subject-typed reference.

### Area 3 — Emission points: which pipeline owns each §6 output

The repo has **two backend pipelines and TS emitters** (CLAUDE.md "Core Pipeline"): clean-arch (hygen, `templates/entity/new/backend/`), clean-lite-ps (hygen, `templates/entity/new/clean-lite-ps/`, the pipeline that consumes patterns today), and TS emitters (`src/emitters/frontend/`, `src/cli/shared/*-emission-generator.ts` for integration). Mapping each §6 output:

- **Role-edge retrieval fragments (§4).** Backend, **clean-lite-ps pipeline**. They are repository/service methods (`findMembersFragment()` / role-scoped finders) generated from the `roles:` block exactly the way `queries:` generates `findByX()`. Entry point would be a new `processRoles()` alongside `processQueries` (`prompt-extension.js:698`), threaded into the repository/service template locals. The fragment-not-list contract (group membership = a Predicate subtree, ADR-0022 §4) is a **runtime base-class** concern (Area 1's `Group` capability owns the fragment-composition method); the emitter only wires the per-entity role/FK facts into it via `config:`/`patternConfig` (the `Activity` pattern's `findBySubjectId` reading `this.patternConfig` is the exact precedent — `activity.pattern.ts:12-20`).

- **Selector registration (Find-target/selector catalog).** This is a **catalog/registry emission** — see Area 4. Closest pipeline is the **integration TS emitters** (`src/cli/shared/adapter-emission-generator.ts`), which already emit per-surface registries and aggregators. A selector catalog keyed by `(entity, role)` mirrors the `<SURFACE>_ENTITY_SOURCES` registry shape.

- **`to_shape` projections.** The **registry mechanism** is a runtime base-class concern (`Individual` ships it); the **per-entity projection wiring** is emitted. Projections are the outbound dual of the read/projection types already generated by clean-lite-ps `buildIntegrationSurface` (`prompt-extension.js:870-974`, per the assembly-default-sinks research). The emitter generates the *registration* of an entity's identity shape into the catalog; ports contribute additional shapes at runtime (Area 4).

- **Auto-wiring onto ApplicationServices.** clean-lite-ps already auto-registers generated query classes into the NestJS module (the `queries:` precedent — module providers threaded at `prompt-extension.js:1158-1208`). The role-edge fragments + selector classes + projection registrations follow the same module-registration path. The `patternConfig` hand-off (`docs/adrs/ADR-031-app-defined-patterns.md:124-148`: `protected override readonly patternConfig = {...}`) is how per-entity role facts reach the base capability with no hand glue.

**Pipeline caveat:** patterns (and therefore any `Group`/`Individual` capability) are consumed by **clean-lite-ps only** today; the `clean` pipeline ignores `pattern:` and emits a no-op warning (`src/patterns/validate-composition.ts:209-233`, `pattern_clean_pipeline_noop`). The lift targets clean-lite-ps; `clean` support is out of scope unless the planner decides otherwise.

### Area 4 — The catalog-by-code / port-contribution seam: closest existing precedent

ADR-0022 leans on "the same catalog-by-code seam as Find targets / named predicates (ADR-0012)" for both the **shape registry** and **selector registration**. codegen-patterns already emits **two** registry/catalog seams that are near-exact precedents:

1. **The integration `changeSources` registry + surface aggregator (RFC-0001 §3).** Each adapter *contributes* `changeSources: Record<string, IChangeSource<unknown>>` (entity-keyed); the **surface module folds** every adapter's contribution into one `IEntityChangeSourceRegistry` bound under `<SURFACE>_ENTITY_SOURCES`:
   - `src/cli/shared/adapter-emission-generator.ts:641-663` `generateSurfaceTokens` — emits `<SURFACE>_ADAPTER_CONTRIBUTIONS` + `<SURFACE>_ENTITY_SOURCES` symbol tokens and the `AdapterContribution { provider, sources }` interface.
   - `:675-720+` `generateSurfaceAggregator` — knowing the full adapter set at emit time, injects each adapter directly and folds `adapter.changeSources` into a `MemoryEntityChangeSourceRegistry` (NestJS has no `multi:true`, so codegen does the fold with full knowledge — `:670-674`). **Two providers serving one entity is a boot error** (one entity → one source, `:673`).

   **This is the closest structural precedent for the shape registry and the selector catalog:** a code-keyed registry, contributions assembled at emit time by a generator that knows the full set, bound under a stable token. The shape registry would be: ports *contribute* shapes (`Record<ShapeCode, Projection>`); a generated aggregator folds them into one `IShapeCatalog` bound under a token; `Individual.to_shape(need)` resolves against it. The selector catalog: `(entity, role)` → selector class, folded the same way.

2. **The orchestration pattern (ADR-032).** `OrchestrationPatternDefinition` (`src/patterns/pattern-definition.ts:228-251`) is *literally* a declarative "catalog-by-code" DI registry: `registry: { keyType, valueType, entries: [{ key, provider }] }` + `coKeyedRegistries` + an optional `dispatcher` with an `assemblySlot` the consumer overrides. Emitted by `src/cli/shared/orchestration-generator.ts`. **If the selector/shape catalog is a port-contributed DI registry, the orchestration-pattern kind is the existing mechanism to emit it** — the planner should evaluate whether the shape registry is a *new* orchestration pattern (`kind: 'orchestration'`) rather than net-new emission code.

3. **Subsystem `forRoot({ backend })` (ADR-008).** The five subsystems (events/jobs/cache/storage/observability) use `DynamicModule.forRoot({ backend })` with `global: true` (CLAUDE.md). This is the *backend-swappable* seam, less directly relevant — the shape registry is contribution-folding (precedent 1), not backend-swapping. But the "core contract + opt-in extensions" rule (CLAUDE.md Operating Principles) maps cleanly: the **core shape catalog** ships the universal identity/Workspace-email shape; **extension shapes** (`SlackTarget`, actuator shapes) are port-contributed opt-ins.

**No existing `to_shape`/selector/projection/role machinery exists in this repo** (grep for `to_shape|Selector|role_map|Individual|Group` returns only incidental hits — job "shape", sink "projection", frontend providers). This is genuinely greenfield codegen against existing *seams*, not an extension of existing selector code.

### Area 5 — The framework/app boundary

The line between what codegen-patterns *generates* and what stays swe-brain *app code*:

| Concern | Framework (codegen generates) | App / swe-brain (stays hand-authored or scaffold-only) |
|---|---|---|
| Role map → repo/service methods | **Yes** — `processRoles()` emits role-scoped finders + fragment-retrieval method signatures, auto-wired (the `queries:` precedent). | — |
| `Group` member-fragment *mechanism* | **Yes** — the `Group` base capability ships `members(): Predicate` composition (cycle-detect + dedup live in the base, ADR-0022 §1). | The **membership source-of-truth is per group type** (ADR-0022 §1 `:29`, ratified Q2). A CRM Account's contacts vs a Slack Channel's participants are *different declared member relations* — the framework generates the fragment *over a declared relation*, but **which relation** is per-entity `config:`/role-map app input. |
| Selector resolution model (Predicate fragment, ONE composed query) | **Scaffold the catalog + the fragment-retrieval seam.** | The **Predicate-fragment resolution model itself** (RFC-0002 §4) and **dispatch-time live resolution (option B, riding ADR-0021)** are swe-brain runtime concerns. The framework can generate the *selector registration* and the *fragment method*; it cannot own *when* resolution fires (dispatch admission is ADR-0021, swe-brain). |
| `to_shape` registry *mechanism* | **Yes** — the catalog seam + the universal identity/Workspace-email shape (precedent: surface aggregator fold). | **Port-contributed extension shapes** (`SlackTarget`, actuator shapes) are app/port code registered *into* the catalog. The framework owns the catalog and the universal shape; ports own their shapes. |
| Cycle-detection / dedup implementation | **Yes** — a base-class algorithm (ADR-0022 "Remaining" `:96`). | — |
| Dispatch-time membership resolution | **No** — swe-brain (ADR-0021 dispatch admission). Framework only emits the fragment-producing seam the dispatcher calls. | **Yes** — the resolver that fires at dispatch is swe-brain app code. |

**Explicit on the two ADR-0022 claims the prompt flags:**
- *Membership source-of-truth is per-group-type* → the framework **can only scaffold** this. It generates a uniform `members()`/fragment interface (ADR-0022 §1 "the *interface* is uniform"), but the concrete member relation per group type is declared app input (role map / `config:`), not framework-owned. The framework owns the *shape*, the app owns the *binding*.
- *Resolution is live-at-dispatch* → **purely swe-brain (ADR-0021)**. The framework generates the selector (the stored net) and the fragment seam; it does *not* own the dispatch-time admission that resolves it. Live resolution "rides ADR-0021's dispatch-side predicate admission" (ADR-0022 §4 `:65`) — ADR-0021 is a swe-brain ADR, not in codegen-patterns.

### Area 6 — Sequencing & risk

ADR-0022 is **explicit**: build in swe-brain dogfood first, lift once proven (`§6 :73`, "built in swe-brain first, but designed so the framework lift is mechanical"). The `job-creator-v0` stack (#250–#256) is the **scalar-leaf floor** being built in swe-brain now (the F1 `FieldType` typed-slot kernel; ADR-0022 §3 "The stack is the leaf half; this ADR is the edge half").

**What must be proven in the dogfood before the codegen lift is safe:**
1. The **role map declares cleanly** for ≥2 different interaction entities (email, meeting) with the full core vocab including the set-difference roles (`invitee`/`attendee`/`bcc`) — proving the YAML shape before it becomes a Zod schema.
2. The **`Group` member-fragment** actually composes to one query across ≥2 *different group types* (CRM Account vs Slack Channel) with *different* member relations — proving the "uniform interface, per-type source-of-truth" split is real, not aspirational.
3. **Nested/transitive group resolution** with cycle-detect + dedup works at unbounded depth terminating at a Person leaf (ratified Q2) — this is the hardest runtime algorithm and must be a proven base-class before it ships as a library capability.
4. **`to_shape` port-contribution** registers ≥1 non-universal shape (`SlackTarget`) *without a running app* at codegen time — proving the registry seam works the way the surface aggregator does (fold-at-emit), not requiring runtime reflection.
5. The **composition story** (`Integrated` + `Group` on one subject entity) is exercised — because Area 1's single-base emission gap will surface the moment a real subject entity needs to be both integrated *and* a group.

## Boundaries

**In scope for the eventual lift (what /plan would decompose):**
- A `roles:` (or equivalent) Zod block on `EntityDefinitionSchema` + parser + analyzer validation (the `queries:`/`SinkPolicy` precedent).
- `Individual`/`Group` as composable capabilities — **gated on resolving the composition-emission gap (Area 1)**.
- `processRoles()` emission in clean-lite-ps: role-edge retrieval fragments + auto-wired service surface.
- A shape registry + selector catalog as a port-contribution seam (the surface-aggregator / orchestration-pattern precedent).
- The runtime base-class algorithms: fragment composition, cycle-detect, dedup, `to_shape` catalog.

**Adjacent but out of scope (stays swe-brain / separate work):**
- The Predicate-fragment resolution model (RFC-0002 §4) and dispatch-time live resolution (ADR-0021) — swe-brain runtime.
- Port-contributed extension shapes (`SlackTarget`, actuator shapes) — app/port code.
- Per-group-type membership *source-of-truth* bindings — app config.
- The `clean` (full Clean Architecture) pipeline — patterns are clean-lite-ps-only today.
- Anything before the swe-brain dogfood proves the five items in Area 6.

## Open questions for /plan

1. **(LOAD-BEARING) How does codegen compose behavioural capabilities under TypeScript single-inheritance?** Today only `patterns[0]` drives the base class (`prompt-extension.js:86-106`); subsequent patterns contribute *columns/behaviors only*, silently dropping their `repositoryClass`/`serviceClass`/methods. ADR-0022's "both, layered" (`Integrated` + `Group` + `Individual` on one subject) **cannot be emitted today**. Options to weigh: (a) TS mixins (`WithAnalytics` precedent, `runtime/base-classes/with-analytics.ts`), (b) a generated composed-base file, (c) **capability-as-config-driven-delegate** (the `Activity` pattern shape — `Group`/`Individual` are NOT base classes, they are delegates the base news-up from `config:`/role-map; sidesteps single-inheritance entirely). This decision gates the whole lift.
2. **Is the role map per-interaction-entity or global?** ADR-0022 §2 says "each interaction declares its role map" (per-entity). But the role *vocabulary* is shared-core. Does the core vocab live in a global registry (config/codegen) with per-entity extension, or is it purely per-entity YAML? Affects whether there's a `roles` config-level surface or only an entity-level block.
3. **Does the role-edge target reuse `entity_ref`/`allowed_types`, or a new subject-typed reference?** The lattice's "target: subject (person|group)" cardinality overlaps the existing polymorphic `entity_ref` (`entity-definition.schema.ts:33,271-279`). Reuse vs parallel machinery.
4. **Is the role map a sibling `roles:` block or an annotation on `relationships:`?** A role-edge is a relationship + role label + subject assertion. ADR-0022 frames it as a distinct map (favouring a sibling block), but `relationships:` already models typed edges (`:364-390`).
5. **Is the shape/selector registry a new orchestration pattern (`kind: 'orchestration'`) or net-new emission code?** ADR-032's `OrchestrationPatternDefinition` (`pattern-definition.ts:228-251`) is already a declarative port-contributed DI registry + dispatcher. The shape catalog may *be* an orchestration pattern rather than bespoke emission.
6. **How do `to_shape` ports register shapes without a running app?** The surface aggregator folds contributions *at emit time* with full knowledge of the set (`adapter-emission-generator.ts:675+`). Can the shape catalog be folded the same way (codegen knows the port set), or does it need runtime registration? ADR-0022 wants port-contribution; the framework needs to know whether that's a build-time fold or a runtime DI bind.
7. **Sequencing vs RFC-0004 / assembly-sinks:** the integration emitters (`src/cli/shared/*-emission-generator.ts`) are slated to move out of `cli/` (memory `project_emitters_misplaced_under_cli`); the selector/shape catalog emission would land in the same neighbourhood. Coordinate placement so the lift doesn't fight the relocation.

## What I could not determine

- **The concrete swe-brain F1/F3/Predicate shapes.** I did not grep the swe-brain repo for the F1 `FieldType`/`accepts()` kernel (PR #4), the F3 `ChannelSelect` picker, or the named-predicate catalog — the codegen-patterns mapping was determinable from ADR-0022 + the distilled memory without them. If /plan needs the *exact* TS shapes the framework must lift (e.g. the `accepts()` discriminant signature, the `ChannelSelect` props), a follow-up read of `/Users/dug/Projects/swe-brain/swe-brain` is warranted. ADR-0022 §3 says `accepts()`'s `scalar`-vs-`ref` discriminant *is* the leaf/edge line — that's the integration point, but I did not verify its concrete signature.
- **Whether the dogfood has started.** The job-creator-v0 stack status (scalar-leaf floor, #250–#256) is from the memory, not re-verified in swe-brain — the memory says it's "mechanically merge-ready" but the selector/edge half is unbuilt. The five Area-6 proof items are *my* derivation of the dogfood gate, not an ADR-stated checklist.
- **The exact runtime home for `Individual`/`Group` base capabilities.** They'd live in `runtime/base-classes/` alongside `integrated-entity-{repository,service}.ts`, but whether they're repository-side, service-side, or a standalone capability module depends entirely on Open Question #1's composition resolution.

## Recommended next agent

**`/plan`** — but **gated on the swe-brain dogfood proving the Area-6 items first** (per ADR-0022's explicit build-dogfood-first mandate). The single decision that must precede any decomposition is Open Question #1 (capability composition under single-inheritance); everything else is mechanical once that's settled. If the dogfood is not yet built, the next step is *not* /plan but tracking the swe-brain stack to the point where the role-map + member-fragment + `to_shape` shapes are proven.
