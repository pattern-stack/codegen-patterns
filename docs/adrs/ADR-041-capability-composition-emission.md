# ADR-041 — Capability Composition Emission (multi-pattern repositories/services via a spine base + layered capabilities)

**Status:** Accepted
**Date:** 2026-06-15
**Owner:** Doug
**Related:** ADR-031 (App-Defined Patterns — this extends it with a third `pattern:` kind), ADR-032 (Orchestration Patterns — the sibling second kind), ADR-005 (superseded family enum), swe-brain `ADR-0022-subject-lattice-role-edges-selectors` (the driving consumer; this ADR is the codegen-side mechanism its §6 lift depends on)
**Research:** `.ai-docs/research/capability-composition-emission.md` (strategy survey + the verified generic-mixin-depth spike), `.ai-docs/research/subject-lattice-codegen-lift.md` (the §6 lift this unblocks)

> **Sequencing note.** This ADR settles the *mechanism* for multi-capability emission. It does **not** trigger implementation. Per swe-brain ADR-0022's build-dogfood-first mandate, the subject-lattice capabilities (`Group`/`Individual`) are hand-built in swe-brain first; the codegen lift here is mechanical once their shapes prove out. This decision exists so that lift — and any other multi-capability consumer — has a settled, verified target rather than re-litigating single-inheritance at build time.

## Context

ADR-031 made patterns composable at the **YAML + validator** layer: `patterns: [A, B]` is accepted, `src/patterns/validate-composition.ts` unions implied behaviors and hard-errors on column conflicts. But **emission picks exactly one base class** — the clean-lite-ps resolver takes the base from `patterns[0]` and silently drops every later pattern's `repositoryClass`/`serviceClass`/methods (`templates/entity/new/clean-lite-ps/prompt-extension.js:86-107`, doc-comment `:76-82`). So `patterns: [Integrated, Group, Individual]` *validates* but cannot emit all three capabilities' methods onto one repository/service. TypeScript single-inheritance is the wall.

swe-brain ADR-0022's "both, layered" ruling (a subject entity that is `Integrated` **and** a `Group` **and/or** `Individual`) forces the question, but the gap is **general** to the patterns system — any consumer wanting two capabilities' generated methods on one entity hits it.

Three facts constrain the solution space (full trace in the research artifact):

1. **Patterns expose their base as an opaque string name + import, never the class.** `PatternDefinition` carries `repositoryClass?: string` + `repositoryImport?: string` + a doc-comment-only `repositoryInheritedMethods?: string[]` (`src/patterns/pattern-definition.ts:44-59`). This is deliberate (ADR-031 `:81` — keeps codegen free of TS class-evaluation + `reflect-metadata`). **Consequence: codegen cannot see a pattern's methods, so it cannot mechanically merge method bodies.**
2. **A mixin mechanism is already shipped and tsc-gated in this exact pipeline.** `service.ejs.t:39` emits `extends WithAnalytics(<ServiceBase><...>)`; `WithAnalytics` is a real TS mixin (`runtime/base-classes/with-analytics.ts:17-22`).
3. **The gap is asymmetric.** Only **clean-lite-ps** consumes patterns; the **full clean** pipeline ignores them entirely (hardcodes `BaseRepository`, has no service class, emits a `pattern_clean_pipeline_noop` warning — `validate-composition.ts:209-233`).

**Mechanism verified before this decision.** A hermetic `tsc` spike (TS 6.0.3, the repo's compiler) stacked `Group`/`Individual`/`Analytics` capability mixins 4-deep over a faithful `IntegratedEntityRepository<TEntity, TWrite, TProj>` model. Result: no "type instantiation excessively deep" (compiles ~0.03s); generic method signatures survive (`TWrite` rejects wrong input — did not collapse to `any`); the `integrationConfig` **abstract-member contract stays enforced** on the concrete leaf (TS2515 when omitted); per-capability typed methods compose. See the research artifact's **Spike Verdict** section.

## Decision

### 1. Mechanism — a spine base + layered capabilities

A composed entity emits **one inherited spine base** plus **N layered capabilities**, where each capability is either:

- a **TS mixin** applied in the `extends` clause (the shipped `WithAnalytics(Base)` mechanism), or
- a **typed-delegate forwarder** (the `queries:` / CGP-358b service pass-through precedent, `service.ejs.t:94-147`) for a capability with a small, codegen-known method vocab.

When ≥2 capabilities stack, codegen emits a generated `<Entity>ComposedBase` file applying the mixin chain, and the concrete class extends that (readability over a 3-deep inline `extends`).

**Rejected: "synthesize one base by flattening all patterns' methods" (strategy A).** Infeasible — patterns expose opaque string-named bases with no machine-readable method list (Context #1). Codegen cannot merge method bodies it cannot see. A survives only as mixin-application *packaging*, which is exactly the generated `<Entity>ComposedBase` file above.

### 2. Spine selection — by config-bearing base, not by position (Ruling #1)

The spine is **the one pattern whose base carries an abstract-config contract**: `Integrated` (`protected abstract readonly integrationConfig`, `integrated-entity-repository.ts:28`) or `Activity` (`patternConfig`, `activity-entity-repository.ts:42`). Everything else layers as a capability.

- **Not positional.** `patterns[0]` does **not** get a privileged base role; reordering `patterns:` must not change which class is inherited.
- **Two config-bearing bases in one entity is a hard validation error**: *"only one inheritable spine base is allowed; express the other capability as `kind: 'capability'`."* (e.g. `patterns: [Integrated, Activity]` fails until one is authored as a capability.)
- **No config-bearing base** → spine = the default `Base` repository/service; all declared patterns layer as capabilities.

This rule is honest about the actual constraint (only one inheritable base) where positional selection silently hides it.

### 3. A third pattern kind: `kind: 'capability'` (Ruling #2)

`PatternKind` (`pattern-definition.ts:47`, currently `'domain' | 'orchestration'`) gains **`'capability'`**. A capability pattern:

- carries `mixinImport` (the mixin function's import) **and/or** a `forwarderMethods` vocab (the small, known method set it contributes),
- has **no** `repositoryClass`/`serviceClass`-as-spine (it is layered, never inherited as the base),
- may still carry `columns`, `impliedBehaviors`, and a `configSchema`.

This cleanly separates **`domain`** ("a base you *extend*") from **`capability`** ("something you *layer*"), and — load-bearing — it gives codegen the **machine-readable method vocab** it otherwise lacks (Context #1), which is what makes Ruling #3 possible.

### 4. Collision policy — detect what we can see, defer the rest to tsc (Ruling #3)

- For **codegen-known vocabs** — a `capability`'s `forwarderMethods`, `queries:` methods, and relationship forwarders — codegen **pre-detects method-name collisions across the composed set and hard-errors at generation time** (better DX than a downstream compile error).
- For **opaque spine bases** (no visible method list), keep ADR-031's existing stance: name clashes surface as **TypeScript compile errors at consumer build** (`validate-composition.ts:17-20`).

Generation-time detection is only possible *because* Ruling #2 makes capability methods visible; the opaque-base remainder is irreducible and stays a tsc concern.

### 5. Migration scope — new capabilities only, for now (Ruling #4)

Only the **new** lattice capabilities (`Group`/`Individual`) ship in `kind: 'capability'` form initially. `Integrated`/`Activity` remain spine-only inheritance bases. We do **not** dual-author the existing library patterns into both base and mixin forms until a real consumer needs one of them as a *non-spine* capability. (The no-backwards-compat rule lets us restructure freely — YAGNI says don't, yet.)

### 6. Baked defaults (low-controversy; flagged for completeness)

- **Ordering / precedence.** Declaration order in `patterns: [...]` defines mixin nesting (rightmost = outermost). Last-applied wins on an *un-flagged* clash; Ruling #3 hard-errors *known* clashes first, so precedence only resolves genuinely-invisible (opaque-base) overlaps. Order is deterministic and documented.
- **Composed-base emission.** A generated `<Entity>ComposedBase` file when ≥2 capabilities stack; inline `extends Capability(Spine<...>)` when exactly one capability layers.
- **Config hand-off for non-spine capabilities.** A **mixin** capability reads its per-entity `config:` via an inherited property (the `WithAnalytics` `analytics?` model — a property the concrete class fills, not a constructor arg). A **delegate** capability receives config at construction. The capability definition declares which.
- **Clean pipeline.** Explicitly **deferred** — it consumes no patterns today (ADR-031 `:213` defers clean pattern support to "additive Phase 3+"). Documented asymmetry; the subject lattice does not force clean support. Scope all of the above to **clean-lite-ps**.

## Consequences

**Positive.**
- Composition now both *validates* (ADR-031) **and** *emits*.
- The mechanism is **verified, not assumed** — the spike clears depth, generic-erasure, and abstract-member-enforcement risks.
- `kind: 'capability'` separates extend-from-layer and unlocks generation-time collision DX.
- Minimal blast radius — reuses the shipped `WithAnalytics` mixin and the `queries:`/CGP-358b forwarder precedents; no new emission paradigm.
- The spine rule states the real single-inheritance constraint instead of hiding it behind `patterns[0]`.

**Cost.**
- A third `PatternKind` + the `mixinImport`/`forwarderMethods` schema fields.
- Capability patterns must enumerate `forwarderMethods` — viable only for *small, known* vocabs (the lattice's `members()`/`toShape()` qualify).
- A generated `<Entity>ComposedBase` file per ≥2-capability entity (extra artifact + import).
- A multi-pattern smoke fixture is required (see below).

**Testing / safety.**
- Baseline snapshot tests are **clean-arch-only** and do not consume patterns — they will **not** catch composition-emission changes. Coverage comes from **clean-lite-ps template-emission tests** + the **smoke/tsc gate**.
- The spike *models* the bases; it does not *import* the drizzle-bearing real classes. A **3-capability smoke fixture that tsc-compiles against the published bases** is the regression guard and must land with the implementation (`just test-smoke-integration`).

## Alternatives considered

- **(A) Generated composed-base by method-flattening** — rejected as infeasible: opaque string-named bases (`pattern-definition.ts:44-59`) give codegen no method list to merge. Survives only as the mixin-application packaging adopted in Decision #1.
- **(B) Mixins-only** — verified and viable, but forces *every* non-spine capability into mixin form (including any future `Integrated`-as-capability). The hybrid keeps the delegate option for small known vocabs, which is more contained.
- **(C) Delegate-only** — sidesteps single-inheritance entirely but orphans the spine's abstract-config hand-off (`integrationConfig`/`patternConfig`) and needs an emitted forwarder for *every* method. Reserved as the fallback had the spike failed; the spike passed, so it is not adopted.
- **Positional spine (`patterns[0]`)** — rejected (Decision #2): silent about the real "only one inheritable base" constraint and fragile under `patterns:` reordering.

## Open follow-ups (implementation-time; not blocking this decision)

1. Pin `Group`/`Individual`'s exact `forwarderMethods` vocab from the swe-brain dogfood (ADR-0022's `members()` / `to_shape()` are the seed).
2. Land the 3-capability smoke fixture (tsc against the real published bases).
3. Confirm how ADR-031's single-depth `extends?` chain interacts with capability layering (likely orthogonal — `extends` builds a spine, capabilities layer on top — but verify at build time).
