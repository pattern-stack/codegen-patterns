# RFC-0002 — Integration Module Assembly Emission (Track D round-2)

**Status:** Accepted (rev 2) — Gate 1.5 cleared (PASS_WITH_NOTES, 0 blockers); ready to implement E0→E4
**Date:** 2026-05-31
**Owner:** Doug
**Related:** RFC-0001 (provider/adapter emission — *this RFC extends its §2 emission targets*), ADR-008 (subsystem protocol→backend→factory), ADR-033/033.1 (`detection:` config), Track C #329 (surface packages), swe-brain ADR-0007 (the per-entity `<x>_integration` L7 module — *the reference shape this RFC generates*), `runtime/subsystems/integration/` (the orchestrator + sink + registry this assembly wires)

## Goal

Extend Track D so YAML generates not just the **read side** (provider module, adapter scaffold, registry, typed views — RFC-0001) but the **integration module assembly**: the per-(surface, entity) feature module that binds the change source + sink, provides a local `ExecuteIntegrationUseCase`, and exports a uniquely-tokened handle a trigger can grab. After this RFC, the "combinable per-adapter module" pattern is the *generated* artifact — fully YAML-driven — and the author fills only the irreducible seam: the `IChangeSource.listChanges` fetch body and any non-generic write logic.

## Context — the gap RFC-0001 left

RFC-0001 framed Track D as a **provider/adapter retarget**. Its §2 emission targets stop at the read side:

```
src/integrations/
  providers/<provider>/<provider>.provider.module.ts        # auth + client
  <surface>/adapters/<provider>/<provider>-<surface>.adapter.ts   # scaffold: changeSources container
  <surface>/adapters/<provider>/…adapter.module.ts          # @generated
  <surface>/<surface>-adapters.module.ts                    # aggregator → <SURFACE>_ENTITY_SOURCES registry
  <surface>/types.generated.ts                              # typed view
```

What it does **not** emit is the **assembly** — the wiring that turns "a registry of change sources" into "a runnable integration per entity":
- the `INTEGRATION_SINK` binding (canonical write surface over the entity's generated repository),
- the per-entity `ExecuteIntegrationUseCase` instance + its unique DI token,
- the feature-module packaging that composes source + sink + the global substrate.

This omission was a **scope artifact, not a decision.** swe-brain's hand-authored `src/modules/<x>_integration` modules — the patterns Track D was built to upstream — *had* this assembly. RFC-0001 lifted their decomposition (ports, registry) but not their assembly. This RFC closes that gap. Per CLAUDE.md: no backwards compat; the generated assembly replaces the hand-rolled feature modules outright.

### The reference shape (proven, in production)

swe-brain `transcript-integration.module.ts` is the exact target B generates (condensed):

```ts
@Module({
  imports: [TranscriptsModule, /* entity repo */ InteractionModule, /* surface/client */ RawLandingModule],
  providers: [
    { provide: INTEGRATION_CHANGE_SOURCE,
      useFactory: (surfaceFactory, rawObjects) => makeTranscriptChangeSource({ surfaceFactory, rawObjects }),
      inject: [INTERACTION_SURFACE_FACTORY, IntegrationRawObjectRepository] },
    { provide: INTEGRATION_SINK,
      useFactory: (repo) => new TranscriptIntegrationSink(repo, 'google'),
      inject: [TranscriptRepository] },
    ExecuteIntegrationUseCase,
    { provide: TRANSCRIPT_INTEGRATION_USE_CASE__GOOGLE, useExisting: ExecuteIntegrationUseCase },
  ],
  exports: [ExecuteIntegrationUseCase, TRANSCRIPT_INTEGRATION_USE_CASE__GOOGLE],
})
export class TranscriptIntegrationModule {}
```

> **Binding-strategy note.** This reference binds `INTEGRATION_CHANGE_SOURCE` via a *free factory* (`makeTranscriptChangeSource({ surfaceFactory, rawObjects })`) injecting a surface client + raw-object repo. Option A (§3) instead standardizes on `adapter.changeSources['<entity>']` — the source is built **once**, inside the adapter's `changeSources` container (RFC-0001's read-side seam), and the assembly reads it from there rather than re-constructing it. Same source, single construction site. The §2 generated example uses the `adapter.changeSources[...]` form; the free-factory form above is the hand-authored predecessor it replaces, shown for provenance only.

Three facts this encodes, which the emission must preserve:
1. **One module per (entity, provider).** Nest module encapsulation gives each its own `INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK`, so each local `ExecuteIntegrationUseCase` resolves the right pair.
2. **The bare `ExecuteIntegrationUseCase` token is ambiguous at app root** (every module provides it) → each module aliases its instance under a unique token `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` via `useExisting`, and exports it.
3. **Substrate is global.** Cursor store, run recorder, differ, multi-tenant flag come from `IntegrationModule.forRoot(...)` in AppModule — never re-bound per feature module.

### The orchestrator constraint (why this needs a design call)

`ExecuteIntegrationUseCase` (verified, constructor at `execute-integration.use-case.ts:112`, source `:113` / sink `:116`) is DI-bound to a **single** `INTEGRATION_CHANGE_SOURCE` and a **single** `INTEGRATION_SINK` per instance. But RFC-0001's registry (`<SURFACE>_ENTITY_SOURCES`, a C7 `IEntityChangeSourceRegistry`) holds **many** sources keyed by entity. The assembly must bridge one-orchestrator-per-source against a many-source registry. `execute()` does expose `sourceOverride?: IChangeSource<T>`, so both bridging strategies are viable (§3 decision).

## 1. Emission targets (extends RFC-0001 §2)

Per (surface, provider, entity-with-`surface:`), additionally emit:

```
src/integrations/<surface>/
  modules/<provider>/<entity>-integration.module.ts     # @generated — the assembly (NEW)
  sinks/<entity>.sink.ts                                 # SCAFFOLD (emit-once) — default sink, author-overridable (NEW)
  <surface>-integration.module.ts                        # @generated — aggregates the per-entity modules (NEW)
  <surface>-integration.tokens.ts                        # @generated — the <ENTITY>_INTEGRATION_USE_CASE__<PROVIDER> tokens (NEW)
```

**Hand-edit boundaries** (same discipline as RFC-0001 §2):
- **`@generated` (re-emitted, never hand-edited):** the per-entity `*-integration.module.ts`, the surface aggregator module, the tokens file.
- **Emit-once scaffold (author-owned after first emit):** `sinks/<entity>.sink.ts` — codegen emits a default `IIntegrationSink<T>` over the entity's generated repository; the author may override write logic. Carries the `// <CODEGEN-SCAFFOLD-V1>` sentinel.
- **Unchanged author-seam:** the `IChangeSource.listChanges` fetch body inside the adapter scaffold's `changeSources` (RFC-0001 §4).

## 2. The generated per-entity assembly module

For entity `meeting` (surface `calendar`, provider `google`), emit `calendar/modules/google/meeting-integration.module.ts`:

```ts
// @generated by @pattern-stack/codegen from definitions/providers/google.yaml — DO NOT EDIT.
@Module({
  imports: [MeetingModule /* generated repo */, GoogleCalendarAdapterModule /* RFC-0001 read side */, RawLandingModule],
  providers: [
    { provide: INTEGRATION_CHANGE_SOURCE,
      // §3 decision determines this line:
      useFactory: (adapter: GoogleCalendarAdapter) => adapter.changeSources['meeting'],
      inject: [GoogleCalendarAdapter] },
    { provide: INTEGRATION_SINK,
      useFactory: (repo: MeetingRepository) => new MeetingSink(repo, 'google'),
      inject: [MeetingRepository] },
    ExecuteIntegrationUseCase,
    { provide: MEETING_INTEGRATION_USE_CASE__GOOGLE, useExisting: ExecuteIntegrationUseCase },
  ],
  exports: [MEETING_INTEGRATION_USE_CASE__GOOGLE],
})
export class MeetingIntegrationModule__Google {}
```

Everything here is derivable from YAML: the entity (`surface:` tag) → repo module + sink import; the provider (`definitions/providers/google.yaml`) → adapter import + provider literal; the (entity, provider) pair → token name + module class name.

## 3. KEY DECISION — how the orchestrator gets its source (one registry, many sources)

This is the one genuinely open design fork; everything else is mechanical once it's picked.

- **Option A (recommended) — bind from the adapter's `changeSources`.** The generated module binds `INTEGRATION_CHANGE_SOURCE = adapter.changeSources['<entity>']` (as shown §2). Closest to swe-brain's proven shape — the orchestrator keeps its single-source DI model; the registry (`<SURFACE>_ENTITY_SOURCES`) remains for entity-agnostic resolution elsewhere (e.g. a future generic runner) but the per-entity run path doesn't depend on it. **Pro:** faithful to the reference, simplest DI, no `sourceOverride` plumbing. **Con:** the source is reachable two ways (registry + direct bind) — minor redundancy.
- **Option B — registry + `sourceOverride`.** Bind no `INTEGRATION_CHANGE_SOURCE`; a per-surface runner injects `<SURFACE>_ENTITY_SOURCES` and calls `execute({ subscription, sourceOverride: registry.get(entity), ... })`. **Pro:** registry is the single source of truth; one runner per surface instead of one module per entity. **Con:** diverges from the proven shape; the orchestrator's DI-bound source becomes vestigial; multi-sink-per-runner reintroduces the same one-sink constraint at the runner.

**Recommendation: Option A.** It generates the shape swe-brain already proved in production and respects the orchestrator's existing contract without reshaping it. Option B is worth revisiting only if/when the generic-runner + multi-provider (#414) story makes a per-surface runner the dominant path.

> **RESOLVED (2026-05-31, Doug): Option A, with the adapter-edge fix (E0).** Ratified. Grounding verified against runtime: `ExecuteIntegrationUseCase` injects `INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK` directly (`execute-integration.use-case.ts:113,116`) and does **not** inject `IEntityChangeSourceRegistry` — so binding the source from `adapter.changeSources['<entity>']` keeps the per-entity run path entirely off the registry. The registry (`<SURFACE>_ENTITY_SOURCES`) stays for entity-agnostic resolution where a consuming port exists.
>
> **Gate-1.5 correction (the adapter-edge blocker).** The first draft assumed the assembly could import the adapter module standalone. It cannot *as RFC-0001 emits it today*: the adapter scaffold's constructor injects a third arg, `@Inject(<SURFACE>_ENTITY_SOURCES) readonly sources: IEntityChangeSourceRegistry` (`adapter-emission-generator.ts:301`), whose **sole provider** is the collision-throwing surface aggregator (`generateSurfaceAggregator`, `:478`). That injection is **read by nothing** in the emitted scaffold (no `this.sources` reference exists; the L2 readers use `this.client`/`this.auth`) and it forms a latent **DI cycle** — the aggregator injects each adapter to read `.changeSources` (`:475`), while each adapter injects the registry the aggregator *produces* (adapter → `ENTITY_SOURCES` → contributions → adapter). The D7 snapshot only diffs emitted text and never boots a Nest container, and swe-brain still runs hand-rolled modules, so this wiring has never been instantiated.
>
> **Fix (ii), chosen — E0, before E1:** drop the `IEntityChangeSourceRegistry` injection from the RFC-0001 adapter scaffold (`generateAdapterScaffold`, remove the `:285` type import line for `IEntityChangeSourceRegistry`, the `:289` tokens import, and the `:301` constructor arg). The adapter becomes **standalone-importable**; the aggregator still emits `<SURFACE>_ENTITY_SOURCES` by injecting each adapter and reading `.changeSources` (one-directional now — cycle broken). This (a) makes "the per-entity run path never touches the registry" literally true, (b) removes a vestigial unused injection, (c) fixes the latent boot cycle. The automatic registry and its real consumers (C6 `CrmPort`; any future generic per-surface runner) are unaffected — they import `<Surface>AdaptersModule` exactly as before. An author who genuinely needs the folded registry inside an adapter method injects the token themselves (opt-in). E0 rebaselines the D7 snapshot fixture (#417). All E1–E4 emission below assumes Option A **after** E0.

## 4. The generated default sink (emit-once scaffold)

`IIntegrationSink<T>` is three methods the orchestrator drives (`integration-sink.protocol.ts`, verified against `execute-integration.use-case.ts`):

```ts
findByExternalId(userId, externalId): Promise<TCanonical | null>          // canonical projection, not raw entity
upsertByExternalId(userId, record: TCanonical, provider): Promise<{ id: string; saved: TCanonical }>
softDeleteByExternalId(userId, externalId): Promise<{ id: string } | null>
// optional: reprojectsOnNoop — reproject EAV/side data on a noop diff
```

> **Signatures verified against `integration-sink.protocol.ts:21-61`.** Two corrections from the first draft: `upsertByExternalId` returns `{ id, saved: TCanonical }` (the full shape — the `saved` projection is part of the contract even though `execute-integration.use-case.ts:300,318` destructures only `{ id }` today), and the read/write type is the **canonical projection** `TCanonical`, not the raw entity.

These are **mechanical over the entity's generated repository — for `pattern: Integrated` entities.** The `integrated` family repo emits `findByExternalIdProjected` + `toProjection` (`integrated-entity-repository.ts:155`, driven by the declarative `IntegrationUpsertConfig`, `integration-upsert-config.ts:5`) and `integrationUpsertOne` / `softDeleteByExternalId`; the default sink adds `userId` scoping, `external_id`/`provider` stamping, and EAV dual-write for entities with `fields:` — all known from the entity definition. The raw repo `findByExternalId` is single-arg and returns the raw entity (`integrated-entity-repository.ts:33`), so the sink wraps the *projected* path, not that one.

**Precondition (E1):** the default sink is emittable only for `pattern: Integrated` entities. A non-integrated `surface:` entity has no projection/`integrationUpsertOne` path — E1 must **hard-error** (clear message naming the entity + the missing `pattern: Integrated`), never emit a non-compiling sink.

Codegen emits a **default sink** implementing the three methods; the author overrides only when write logic is non-generic (swe-brain's `TranscriptIntegrationSink` is exactly such a hand-authored sink — its body becomes the override seam). Emit-once so an override survives regen.

## 5. The trigger is out of scope (author/subsystem seam)

What *invokes* `execute()` — a cron, a job, a CLI command, a webhook handler — constructs the per-run `subscription` (id, domain, externalRef), `userId`, `direction`, `action`, `tenantId`. That stays consumer-owned (the exported `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` token is the handle it grabs). A future integration↔jobs-subsystem bridge could generate scheduled triggers, but it is **not** in this RFC. This RFC emits the runnable use-case + token; the consumer decides when to run it.

## 6. Relationship to RFC-0001 / what changes

| RFC-0001 artifact | disposition under this RFC |
|---|---|
| provider module, `<surface>-adapters.module.ts` aggregator, `types.generated.ts`, tokens | **Kept, unchanged.** The aggregator still emits `<SURFACE>_ENTITY_SOURCES` for entity-agnostic consumers; it is no longer on the per-entity run path. |
| **adapter scaffold** (`generateAdapterScaffold`) | **Changed (E0).** Drops the `IEntityChangeSourceRegistry` constructor injection (`:301`) so the adapter is standalone-importable and the latent DI cycle is removed (§3 resolution). The assembly imports the adapter module and reads `changeSources` (Option A). |
| adapter scaffold `changeSources` (author fills the `IChangeSource` bodies) | **Kept** — still the read-side author-seam. |
| (nothing) | **NEW:** per-entity assembly module, default sink scaffold, surface integration aggregator, use-case tokens (§1). |

swe-brain consumer impact: the hand-rolled `src/modules/{email,meeting,transcript}_integration` modules + hand-authored sinks are **deleted**, replaced by the generated assembly; the vendor fetch bodies move into the adapter `changeSources`, and any non-generic write logic moves into the emit-once sink override.

## 7. Open questions — RESOLVED (2026-05-31, Doug)

1. **§3 Option A vs B** — **RESOLVED: Option A.** See the resolution callout under §3.

2. **Sink override mechanism** — **RESOLVED: emit-once scaffold** (author edits in place), consistent with RFC-0001 §4 and the read-side `changeSources` seam. The default sink carries the `// <CODEGEN-SCAFFOLD-V1>` sentinel; regen skips files that already exist (an override survives). No abstract-base/subclass indirection — it would add a layer purely for uniformity (CLAUDE.md: collapse such layers) and split the write logic across two files.

3. **Multi-provider (#414)** — **RESOLVED: defer #414's L1 contract reshape; the boot-collision is genuinely avoided once E0 lands.** Under Option A the assembly is *already* per-(entity, provider) — class `<Entity>IntegrationModule__<Provider>`, token `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>`, provider passed as a sink constructor arg — so a second provider for the same entity (e.g. Gong transcripts alongside Google) is **purely incremental**: one more assembly module + one more token, sharing the sink class. Verified incremental, not a refactor:
   - The genuine #414 work — reshaping the L1 entity-keyed `IEntityChangeSourceRegistry.get(entityName)` into an (entity, provider) contract — is consumed **only** by the C6 `CrmPort` on the `crm` surface (`adapter-emission-generator.ts:20`). All surfaces carry a `portType` (calendar/mail/transcript have `CalendarPort`/`MailPort`/`TranscriptPort` with `l2Ports: []`, `:116-136`) — so the earlier draft's "port-less surface" framing was **wrong** and is struck; the distinguishing fact is not "has a port" but "**a consumer resolves the entity-keyed registry at runtime**," which today is only `crm`/`CrmPort`. The L1 refactor is forced only by a multi-provider *crm* surface, which is not on the immediate horizon. → **defer (#414).**
   - **The boot-collision and why E0 dissolves it.** The RFC-0001 surface-aggregator fold (`adapter-emission-generator.ts:452-462`) **throws at boot** when two providers serve one entity, and runs whenever `<Surface>AdaptersModule` is constructed. The first draft claimed this fold "stays dormant" because AppModule would import only the assembly modules — but **pre-E0 that is false**: the assembly imports the adapter module, and the adapter's `:301` injection forces `<Surface>AdaptersModule` (the fold) into the graph transitively. **E0 removes that injection** (§3 resolution), so post-E0 the adapter module *is* standalone and AppModule wires `[assembly modules + their adapter modules + IntegrationModule.forRoot]` **without** importing `<Surface>AdaptersModule`. The collision fold is then genuinely off the graph for the Gong case — not "dormant," absent. `<Surface>AdaptersModule` is imported only where a registry consumer (`crm`/`CrmPort`) needs it; a multi-provider *crm* surface would still hit the fold, which is exactly the deferred #414 scope. E2/E3 must make this AppModule-level wiring explicit, and the snapshot fixture (§8) must assert the run path imports assembly + adapter modules, **not** the adapters aggregator.

4. **Token naming** — **RESOLVED: `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>`**, SCREAMING_SNAKE_CASE, double-underscore provider separator (matches swe-brain's proven `TRANSCRIPT_INTEGRATION_USE_CASE__GOOGLE`). Module class: `<Entity>IntegrationModule__<Provider>` (PascalCase entity + Pascal provider, double-underscore separator).

## 8. Snapshot + tests

Extend the RFC-0001 §7 integration-emission snapshot fixture (`test/fixtures/integration-patterns/`) to assert the new assembly tree (per-entity module + sink scaffold + aggregator + tokens). Per the standing rule (memory `project_baseline_clean_arch_only`): baseline covers clean-arch only — these emissions need their own template-emission tests, not baseline.

## Sequencing (post-RFC)

- **E0** — adapter-edge fix (§3 resolution): in `generateAdapterScaffold` (`adapter-emission-generator.ts:227`) drop the `IEntityChangeSourceRegistry` injection — the `:285` type import, the `:289` tokens import, and the `:301` constructor arg — and update the now-stale scaffold doc comment (`:224`, still says "injects … the entity sources registry"). Makes the adapter standalone-importable and breaks the latent DI cycle. Rebaseline the D7 integration-emission snapshot (#417). Gates E2 (the assembly imports the adapter). Smallest of the steps; do it first so the blocker can't resurface mid-E2.
- **E1** — default `IIntegrationSink` emitter (emit-once scaffold over the generated repo, `pattern: Integrated` only — hard-error otherwise) + tests.
- **E2** — per-entity assembly module emitter (§2) + tokens file; wire into the `entity new` post-step alongside the existing adapter emission.
- **E3** — surface integration aggregator (`<surface>-integration.module.ts`).
- **E4** — snapshot fixture extension (§8) + template-emission suite.
- **E5** — swe-brain consumes: regen against the new version, fill fetch bodies + sink overrides, delete the hand-rolled feature modules.

## Deliverable

This file, reviewed and merged before E1. The §3 / §7 open questions resolved (or explicitly deferred) in review. Subsequent deviations require a fresh review round.

---

## Design Addendum (rev 2 — response to Gate 1.5 REVISE, 2026-05-31)

The critique below returned **REVISE** (1 blocker / 4 notes / 2 nits). All addressed; the blocker was independently re-verified against `adapter-emission-generator.ts` before revising (the injected `sources` registry is read by nothing — `:301` is the only reference; the L2 readers use `this.client`/`this.auth`). Resolution map:

- **Blocker (adapter-edge DI / re-armed collision):** chose fix **(ii)** — drop the `IEntityChangeSourceRegistry` injection from the RFC-0001 adapter scaffold, added as **E0** (§3 resolution callout, §6 table, Sequencing). Also surfaced the latent DI cycle the injection forms. Post-E0 the adapter is standalone-importable and the collision fold is *absent* (not "dormant") from the Gong run path.
- **Note 1 (sink `upsertByExternalId` return):** §4 corrected to `Promise<{ id: string; saved: TCanonical }>`; read/write type corrected to canonical projection `TCanonical`.
- **Note 2 (`pattern: Integrated` precondition):** §4 now states the default sink is emittable only for `pattern: Integrated`; E1 hard-errors otherwise. Clarified the sink wraps `findByExternalIdProjected` + `toProjection`, not the raw single-arg `findByExternalId`.
- **Note 3 (orchestrator decoupling sound; adapter-edge was the break):** kept the orchestrator analysis; the adapter-edge analysis is repaired via E0.
- **Note 4 ("bound-but-unread" wrong at DI-graph level):** struck; §7 q3 reworded — the registry *was* injected at the adapter (the bug); post-E0 it is genuinely off the run-path graph.
- **Nit 1 (`:108` cite):** fixed to constructor `:112` (source `:113`/sink `:116`).
- **Nit 2 (§0 factory vs §2 `changeSources` divergence):** §0 now carries a binding-strategy note reconciling the free-factory predecessor with Option A's single-construction-site `adapter.changeSources[...]`.

---

## Spec Review (Gate 1.5 critique — 2026-05-31)
<!-- written by: reviewer · gate 1.5 · ad-hoc critique · lens=mixed -->

**Target:** `docs/rfcs/RFC-0002-integration-module-assembly-emission.md`
**Against:** `cited-code` (`runtime/subsystems/integration/`, `src/cli/shared/adapter-emission-generator.ts`)
**Lens:** mixed
**Verdict:** REVISE

**Blockers (1):**

- [`§2 line 87-92, §3 line 110, §7 q3 lines 151-152` vs `adapter-emission-generator.ts:298-302,478`] **The Option-A wiring does not resolve as specified — the adapter the assembly imports has a hard DI dependency on the very aggregator the RFC claims stays dormant.** The emitted adapter scaffold's constructor injects a *third* dependency the RFC never accounts for: `@Inject(<SURFACE>_ENTITY_SOURCES) readonly sources: IEntityChangeSourceRegistry` (`adapter-emission-generator.ts:298-302`). The **sole** provider of `<SURFACE>_ENTITY_SOURCES` is the surface aggregator `<Surface>AdaptersModule` (the only `provide:` is at `:478`, inside `generateSurfaceAggregator`, which also holds the throw-on-collision fold at `:452-462`). The RFC §2 assembly module imports only `GoogleCalendarAdapterModule` (which provides+exports `GoogleCalendarAdapter` but neither provides nor imports `CALENDAR_ENTITY_SOURCES` — `:330-335`). Therefore, when AppModule imports the assembly modules and not the aggregator (the §7 q3 mitigation), Nest cannot resolve `GoogleCalendarAdapter`'s third constructor arg → boot-time DI resolution error; and the alternative — importing the aggregator to satisfy it — **re-arms the exact collision fold §7 q3 says is dormant.** The "fold stays dormant for port-less surfaces" reasoning fails because (a) the adapter→registry edge is transitive through the imported adapter module, and (b) calendar/mail/transcript are **not** port-less — they each carry a real `portType` (`CalendarPort`/`MailPort`/`TranscriptPort`, `SURFACE_REGISTRY` `:116-136`) with `l2Ports: []`, and the aggregator is emitted **unconditionally** for every `SURFACE_REGISTRY` surface (`:643`), not gated on port presence. _Fix:_ resolve the source-binding seam before E2. Pick one and write it into §2/§3/§7q3 explicitly: (i) have the assembly module import the aggregator AND make the fold tolerate the single-provider-per-entity case so it never throws on the port-less run path (turns "dormant" into "provably non-throwing for one provider"); or (ii) change the generated adapter scaffold (RFC-0001) to drop the `IEntityChangeSourceRegistry` constructor injection so the adapter is importable standalone (registry resolution moves entirely to the aggregator/runner that actually reads it) — this is the cleaner Option-A-faithful fix and matches the RFC's claim that the per-entity run path "never touches the registry"; or (iii) bind `INTEGRATION_CHANGE_SOURCE` via a free factory function `makeChangeSource(...)` rather than `adapter.changeSources['<entity>']`, eliminating the adapter import (and its registry edge) from the assembly entirely (closer to swe-brain's `makeTranscriptChangeSource` factory in the §0 reference, which does NOT inject the adapter). Note that the swe-brain reference shape (§0 lines 41-42) uses a **factory + surface client**, not `adapter.changeSources[...]` — the RFC's §2 example silently diverges from its own cited reference here.

**Notes (4):**

- [`§4 line 123` vs `integration-sink.protocol.ts:41-45`] `upsertByExternalId` return type is mis-stated. RFC shows `Promise<{ id }>`; the real protocol returns `Promise<{ id: string; saved: TCanonical }>`. The `saved` projection is load-bearing (the orchestrator does not consume it today — `execute-integration.use-case.ts:300,318` destructures only `{ id }` — but the contract requires emitting it). The E1 emitter must produce the full shape; flag so the truncated `{ id }` doesn't get baked into the default-sink template.
- [`§4 lines 122-124, 128`] The sink signatures are otherwise faithful (`findByExternalId(userId, externalId)`, `softDeleteByExternalId(userId, externalId) → {id}|null`, `reprojectsOnNoop?` — all match `:21-61`), but "mechanical over the entity's generated repository" understates the seam. The repo's `findByExternalId` takes a *single* arg and returns the raw entity (`integrated-entity-repository.ts:33`); the sink must add `userId` scoping and return a **canonical projection** (`findByExternalIdProjected` + `toProjection`, `:155` / `integration-upsert-config.ts:5`). The machinery exists and is declarative (`IntegrationUpsertConfig`, template-emitted per `pattern: Integrated`), so the claim holds — but the default sink is mechanical **only for `pattern: Integrated` entities**. State that family precondition in §4/E1; a non-integrated `surface:` entity has no `integrationUpsertOne`/projection path and E1 must either skip it or hard-error rather than emit a non-compiling sink.
- [`§3/§7 q3 lines 115, 151`] The registry-decoupling reasoning's *conclusion* (the orchestrator never injects the registry) is **correct and verified** — `ExecuteIntegrationUseCase` injects only `INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK` (+ cursor/differ/recorder/multiTenant substrate), not `IEntityChangeSourceRegistry` (`execute-integration.use-case.ts:112-121`). The §2 module correctly relies on global substrate from `IntegrationModule.forRoot` for cursor/differ/recorder/multiTenant — that gap is real but covered. The decoupling claim is sound *at the orchestrator*; it breaks only at the *adapter* edge (the blocker). Keep the orchestrator analysis; repair the adapter-edge analysis.
- [`§7 q3 line 151`] "calendar/mail/transcript surfaces bind the registry bound-but-unread" — partially true: no *port* reads it (the `l2Ports: []` surfaces compose L1 + capabilities), but the **adapter constructor** still injects it (`:301`), so "bound-but-unread" is wrong at the DI-graph level even if true at the run-path level. Tighten the wording or it will mislead the E2 implementer into assuming the token can be left unprovided.

**Nits (2):**

- [`§3 line 115`] Inline line-cites `execute-integration.use-case.ts:113,116` for the source/sink inject — accurate (source `:113`, sink `:116`), good. The `:108` cite in §1 line 61 points at the class decorator region, not the constructor; constructor opens at `:112`. Minor.
- [`§0 lines 41-42 vs §2 line 91`] The reference shape uses `makeTranscriptChangeSource({ surfaceFactory, rawObjects })` (a factory injecting a surface client + raw-object repo), but §2's generated example uses `adapter.changeSources['meeting']`. These are two different binding strategies presented as if equivalent; if Option A keeps `adapter.changeSources[...]`, drop or reconcile the factory framing in §0 so the emitter author isn't whipsawed between two reference shapes (this also bears on the blocker fix (iii)).

**Reviewed by:** reviewer agent · 2026-05-31T00:00:00Z

---

## Spec Review — rev 2 re-check (Gate 1.5, 2026-05-31)
<!-- written by: reviewer · gate 1.5 · ad-hoc critique · lens=mixed · rerun -->

**Target:** `docs/rfcs/RFC-0002-integration-module-assembly-emission.md` (rev 2)
**Against:** `cited-code` (`runtime/subsystems/integration/`, `src/cli/shared/adapter-emission-generator.ts`)
**Lens:** mixed
**Verdict:** PASS_WITH_NOTES — **Gate 1.5 CLEARED**

The rev-2 blocker fix is correct, complete, and re-verified against the code. All four notes and both nits from the prior round are resolved. Cleared for E0 → E1.

**Blockers (0):** none. The prior blocker is resolved.

- **Blocker resolution verified (fix ii, E0).** The E0 plan — drop `@Inject(<SURFACE>_ENTITY_SOURCES) readonly sources: IEntityChangeSourceRegistry` (`adapter-emission-generator.ts:301`), its type import (`:285`, `IEntityChangeSourceRegistry` only — `IAuthStrategy`/`IChangeSource` on that import stay, still used), and the tokens import (`:289`) from `generateAdapterScaffold` — is sufficient and behavior-preserving. Re-checked all three claims:
  - **(a) standalone-importable:** the adapter's only other deps are `<PROVIDER>_AUTH_STRATEGY` + `<PROVIDER>_CLIENT`, both provided transitively by the imported `<Provider>ProviderModule` (`generateAdapterModule:330-336` imports it). With the registry arg gone, the adapter module has no edge to `<SURFACE>_ENTITY_SOURCES`. ✔
  - **(b) fold stays one-directional:** `generateSurfaceAggregator` (`:447-486`) injects each adapter class (`:475`) and reads `.changeSources`; removing the adapter→registry back-edge breaks the latent cycle (adapter → ENTITY_SOURCES → contributions fold → adapter). ✔
  - **(c) `this.sources` genuinely unused — behavior-preserving:** confirmed `:301` is the **sole** reference to the injected field in the emitted scaffold. The only method bodies are the L2 readers (`:259-268`), which use `this.client`/`this.auth` and throw `not implemented`; the interaction surfaces this RFC targets (calendar/mail/transcript) carry `l2Ports: []` (`:116-136`), so they emit no readers at all. Nothing reads `sources`. **No second consumer exists.** ✔
- **§7 q3 post-E0 reasoning verified.** "Port-less" framing correctly struck; the substituted distinguishing fact ("a consumer resolves the entity-keyed registry at runtime," only `crm`/`CrmPort`) is accurate. Post-E0, AppModule wires `[assembly modules + their adapter modules + IntegrationModule.forRoot]` without `<Surface>AdaptersModule`, so the throw-on-collision fold (`:452-462`) is **absent** from the Gong run path (not merely "dormant"). The multi-provider-crm case that *would* hit the fold is correctly scoped to the deferred #414. ✔
- **§4 sink corrections verified against `integration-sink.protocol.ts:21-61`.** `upsertByExternalId → Promise<{ id: string; saved: TCanonical }>` (`:41-45`), `findByExternalId(userId, externalId) → TCanonical | null` (`:21-24`), `softDeleteByExternalId(userId, externalId) → { id } | null` (`:51-54`), `reprojectsOnNoop?` (`:61`) — all match. The `pattern: Integrated` precondition + E1 hard-error (§4 line 138) is the right guard; the `findByExternalIdProjected`/`toProjection` wrapping (vs the raw single-arg `findByExternalId`, `integrated-entity-repository.ts:33`/`:155`) is now stated correctly. ✔
- **Nits verified.** §1 constructor cite corrected to `:112` (source `:113`, sink `:116` — all accurate against the file). §0 binding-strategy note (line 54) reconciles the free-factory predecessor with Option A's single-construction-site `adapter.changeSources[...]`. ✔

**Notes (0 new gate-relevant):** the prior 4 notes are all resolved (return shape, `pattern: Integrated` precondition, orchestrator-decoupling kept, "bound-but-unread" struck).

**Nits (2 — non-blocking, fold into E0):**

- [`§3 line 121`, `§6 line 151`, `Sequencing line 175`] The RFC names the function `generateAdapter`; the actual exported function is `generateAdapterScaffold` (`adapter-emission-generator.ts:227`). Harmless in prose but the E0 implementer should target the right symbol — worth a find/replace so the E0 PR description matches.
- [`adapter-emission-generator.ts:224` — code-side, for E0] The scaffold generator's own doc comment still reads "injects L1 (auth strategy + client) and the entity sources registry"; E0 must update that comment alongside the injection removal so the emitted/source docs don't drift. Out of RFC scope; flag for the E0 task.

**Reviewed by:** reviewer agent · 2026-05-31T00:00:00Z (rev 2 re-check)
