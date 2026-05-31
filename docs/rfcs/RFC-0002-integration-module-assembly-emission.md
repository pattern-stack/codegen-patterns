# RFC-0002 — Integration Module Assembly Emission (Track D round-2)

**Status:** Draft
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

Three facts this encodes, which the emission must preserve:
1. **One module per (entity, provider).** Nest module encapsulation gives each its own `INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK`, so each local `ExecuteIntegrationUseCase` resolves the right pair.
2. **The bare `ExecuteIntegrationUseCase` token is ambiguous at app root** (every module provides it) → each module aliases its instance under a unique token `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` via `useExisting`, and exports it.
3. **Substrate is global.** Cursor store, run recorder, differ, multi-tenant flag come from `IntegrationModule.forRoot(...)` in AppModule — never re-bound per feature module.

### The orchestrator constraint (why this needs a design call)

`ExecuteIntegrationUseCase` (verified, `execute-integration.use-case.ts:108`) is DI-bound to a **single** `INTEGRATION_CHANGE_SOURCE` and a **single** `INTEGRATION_SINK` per instance. But RFC-0001's registry (`<SURFACE>_ENTITY_SOURCES`, a C7 `IEntityChangeSourceRegistry`) holds **many** sources keyed by entity. The assembly must bridge one-orchestrator-per-source against a many-source registry. `execute()` does expose `sourceOverride?: IChangeSource<T>`, so both bridging strategies are viable (§3 decision).

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

## 4. The generated default sink (emit-once scaffold)

`IIntegrationSink<T>` is three methods the orchestrator drives (`integration-sink.protocol.ts`, verified against `execute-integration.use-case.ts`):

```ts
findByExternalId(userId, externalId): Promise<T | null>
upsertByExternalId(userId, record: T, provider): Promise<{ id }>
softDeleteByExternalId(userId, externalId): Promise<{ id } | null>
// optional: reprojectsOnNoop — reproject EAV/side data on a noop diff
```

All three are **mechanical over the entity's generated repository** (the repo already emits `findBy*` + an upsert path; canonical→column mapping + `external_id`/`provider` stamping + EAV dual-write for entities with `fields:` are known from the entity definition). Codegen emits a **default sink** implementing them; the author overrides only when write logic is non-generic (swe-brain's `TranscriptIntegrationSink` is exactly such a hand-authored sink — its body becomes the override seam). Emit-once so an override survives regen.

## 5. The trigger is out of scope (author/subsystem seam)

What *invokes* `execute()` — a cron, a job, a CLI command, a webhook handler — constructs the per-run `subscription` (id, domain, externalRef), `userId`, `direction`, `action`, `tenantId`. That stays consumer-owned (the exported `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` token is the handle it grabs). A future integration↔jobs-subsystem bridge could generate scheduled triggers, but it is **not** in this RFC. This RFC emits the runnable use-case + token; the consumer decides when to run it.

## 6. Relationship to RFC-0001 / what changes

| RFC-0001 artifact | disposition under this RFC |
|---|---|
| provider module, adapter scaffold, `<surface>-adapters.module.ts` aggregator, `types.generated.ts`, tokens | **Kept, unchanged.** The assembly imports the adapter module and reads `changeSources` (Option A). |
| adapter scaffold `changeSources` (author fills the `IChangeSource` bodies) | **Kept** — still the read-side author-seam. |
| (nothing) | **NEW:** per-entity assembly module, default sink scaffold, surface integration aggregator, use-case tokens (§1). |

swe-brain consumer impact: the hand-rolled `src/modules/{email,meeting,transcript}_integration` modules + hand-authored sinks are **deleted**, replaced by the generated assembly; the vendor fetch bodies move into the adapter `changeSources`, and any non-generic write logic moves into the emit-once sink override.

## 7. Open questions (resolve before implementation)

1. **§3 Option A vs B** — the source-binding strategy. Recommendation: A. **Needs Doug's confirm.**
2. **Sink override mechanism** — emit-once scaffold (author edits in place) vs a generated abstract base + author subclass. Leaning emit-once scaffold for consistency with RFC-0001 §4; confirm.
3. **Multi-provider (#414)** — Option A sidesteps it per-entity (each module is one provider); the registry collision remains for the same entity from two providers. Decide whether this RFC addresses it or explicitly defers (proposed: defer; single-provider today).
4. **Token naming** — `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` matches swe-brain; confirm casing/format for the generated constant.

## 8. Snapshot + tests

Extend the RFC-0001 §7 integration-emission snapshot fixture (`test/fixtures/integration-patterns/`) to assert the new assembly tree (per-entity module + sink scaffold + aggregator + tokens). Per the standing rule (memory `project_baseline_clean_arch_only`): baseline covers clean-arch only — these emissions need their own template-emission tests, not baseline.

## Sequencing (post-RFC)

- **E1** — default `IIntegrationSink` emitter (emit-once scaffold over the generated repo) + tests.
- **E2** — per-entity assembly module emitter (§2) + tokens file; wire into the `entity new` post-step alongside the existing adapter emission.
- **E3** — surface integration aggregator (`<surface>-integration.module.ts`).
- **E4** — snapshot fixture extension (§8) + template-emission suite.
- **E5** — swe-brain consumes: regen against the new version, fill fetch bodies + sink overrides, delete the hand-rolled feature modules.

## Deliverable

This file, reviewed and merged before E1. The §3 / §7 open questions resolved (or explicitly deferred) in review. Subsequent deviations require a fresh review round.
