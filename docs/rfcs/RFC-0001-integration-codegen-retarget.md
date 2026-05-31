# RFC-0001 — Integration Codegen Retarget (provider/adapter emission model)

**Status:** Draft (D0 deliverable for [#339], gates [#338] D1–D7)
**Date:** 2026-05-31
**Owner:** Doug
**Related:** ADR-033 (config-driven change sources), ADR-033.1 (provider-keyed `detection:`), ADR-033.2 (typed provider artifacts — *deprecated by this RFC, see §8*), ADR-034 (project-level provider registry — *superseded by this RFC, see §8*), ADR-031-auth-subsystem, Track C #329 (surface packages), swe-brain ADR-0006 (domain taxonomy — surfaces span contexts)
**Decisions locked with stakeholder (2026-05-31):** (1) `definitions/providers/*.yaml` is the single source of provider truth, superseding ADR-034's config block; (2) the ADR-033.2 per-entity provider tuples are deprecated and removed once the registry below lands; (3) provider YAML lives at `definitions/providers/` (flat, sibling to `definitions/entities/`).

## Goal

Lock the codegen-emission model for the provider/adapter split before D1 begins schema work, so D1–D7 build against a documented contract instead of re-litigating it. Retarget integration codegen from today's `src/modules/<entity>-sync-source.*` + per-entity provider tuples to a provider/surface-aware tree, and promote providers to first-class declarative artifacts.

## Context — the four-layer model

From the `pattern-stack/integration-patterns` design (2026-04-30 → 05-01), reconciled with ADR-0006 (swe-brain) which made **surfaces span contexts** (one Google OAuth → `calendar`+`mail`+`transcript`; one `transcript` context fed by Google+Gong):

```
L1 Strategies (codegen subsystems: IAuthStrategy, IChangeSource<T>, ISyncSink<T>)
L2 Capabilities (codegen-<surface> packages: type-shaped ports — Track C)
                          ↓
L3 Composing Port (consumer / codegen-<surface>: <Surface>Port — Track C C6)
                          ↓
Provider Adapter scaffolds  ← THIS TRACK emits the wiring
                          ↓
Hand-rolled implementations (consumer fills L2 method bodies)
```

Today's emit conflates **provider** concerns (auth, client) with **adapter** concerns (surface-specific poll-fetch glue), and forces consumers into hand-rolled aggregators via per-entity registry tokens. Track D fixes both. Per CLAUDE.md: no backwards compat — old paths are deleted, migration is one-shot (§6).

---

## 1. `definitions/providers/<provider>.yaml` schema

Providers become **first-class declarative artifacts** (locked decision 1). Codegen no longer infers the provider set from entity `detection:` / `sync.providers:` blocks (ADR-033.1); those blocks remain for per-entity *field mapping & detection config* (ADR-033), but the **provider roster and its auth/client/surface facts live in `definitions/providers/`**.

```yaml
# definitions/providers/google.yaml
slug: google                      # provider id — the same string used as detection: keys, audit rows, subscription rows
display_name: Google
auth:
  type: oauth2                    # 'oauth2' | 'api-key' | 'app-password' | ...
  strategy: '@app/integrations/providers/google/google-oauth.strategy#GoogleOAuthStrategy'  # import-path#export
  scopes:                         # required for oauth2
    - https://www.googleapis.com/auth/calendar.readonly
    - https://www.googleapis.com/auth/gmail.readonly
client:
  class: '@app/integrations/providers/google/google.client#GoogleClient'
  base_url: https://www.googleapis.com
surfaces: [calendar, mail, transcript]   # which surfaces this provider serves (ADR-0006: Google spans three)
# optional:
token_lifetime: 3600
refresh_behavior: rotating
```

```yaml
# definitions/providers/hubspot.yaml — single-surface
slug: hubspot
display_name: HubSpot
auth:
  type: oauth2
  strategy: '@app/integrations/providers/hubspot/hubspot-oauth.strategy#HubspotOAuthStrategy'
  scopes: [crm.objects.contacts.read, crm.objects.deals.read]
client:
  class: '@app/integrations/providers/hubspot/hubspot.client#HubspotClient'
  base_url: https://api.hubapi.com
surfaces: [crm]
```

**Field rules**

| field | req | rule |
|---|---|---|
| `slug` | ✓ | kebab/lower; unique across `definitions/providers/`; the canonical provider id everywhere downstream |
| `auth.type` | ✓ | enum; gates which sub-fields are required (`scopes` required iff `oauth2`) |
| `auth.strategy` | ✓ | `import-path#Export`; class must exist at codegen time (§ pre-flight) |
| `client.class` | ✓ | `import-path#Export`; pre-flight verified |
| `client.base_url` | ✓ | absolute URL |
| `surfaces` | ✓ | each must reference a real `surface:` declared on some `definitions/entities/*.yaml`; non-empty |

**Validation (pre-flight, codegen-time — resolved open question):** `auth.strategy` and `client.class` import paths are resolved and checked for existence *before* emission, not deferred to NestJS DI boot. Rationale: a missing strategy is a one-line YAML/path typo; failing at `cdp gen` with `provider google: auth.strategy '…#GoogleOAuthStrategy' not found at <path>` is dramatically better DX than a boot-time DI failure three layers removed from the cause. `surfaces` are cross-checked against the union of entity `surface:` declarations (a `provider.surfaces` value with no entities is an error — nothing to adapt).

> **Supersedes ADR-034.** The project-level registry ADR-034 placed in `codegen.config.yaml` `providers:` is replaced by this directory. The cross-subsystem "what providers is this app connected to" question (ADR-034's motivation — auth, audit, webhook routing) is answered by scanning `definitions/providers/*.yaml`, which carries strictly more (auth/client/surfaces) than the config block did. ADR-034 moves to `Superseded` with a forward pointer here.

## 2. Emission targets

```
src/integrations/
  providers/<provider>/<provider>.provider.module.ts          # NEW — imports declared strategy + client, provides them
  <surface>/
    adapters/
      <provider>/<provider>-<surface>.adapter.ts              # SCAFFOLD (emit-once) "implements <Surface>Port"
      <provider>/<provider>-<surface>.adapter.module.ts       # retargeted module emit
      index.ts                                                # auto-generated barrel (full re-emit)
    <surface>-adapters.module.ts                              # thin factory aggregator (full re-emit)
    types.generated.ts                                        # per-consumer typed view (full re-emit) — §5
```

**Idempotency contract.** Re-running `cdp gen` on an unchanged `definitions/` tree produces a byte-identical emit (no spurious diffs). The only inputs are the YAML files; ordering is YAML insertion order (stable). This is the same contract the baseline snapshot test enforces today.

**Hand-edit boundaries.** Two classes of output:
- **Fully codegen-owned (re-emitted every run, never hand-edited):** provider modules, adapter modules, `index.ts` barrels, `<surface>-adapters.module.ts`, `types.generated.ts`. Carry the existing `@generated DO-NOT-EDIT` banner.
- **Scaffold, emit-once (author-owned after first emit):** `<provider>-<surface>.adapter.ts` (§4).

## 3. Multi-provider registry contract

Per surface, codegen emits a DI contribution/resolution pair so adapters self-register and consumers get one resolved registry — eliminating the hand-rolled aggregators ADR-033.2's tuples forced.

```ts
// DI tokens (emitted per surface)
export const CRM_ADAPTER_CONTRIBUTIONS = Symbol('CRM_ADAPTER_CONTRIBUTIONS'); // multi: true
export const CRM_ENTITY_SOURCES        = Symbol('CRM_ENTITY_SOURCES');        // resolved registry

// Contribution shape — each provider-adapter module contributes one:
interface AdapterContribution {
  provider: string;                              // provider slug
  sources: Record<EntityName, IChangeSource<unknown>>;  // entities this provider serves on this surface
}

// Aggregator factory (emitted in <surface>-adapters.module.ts):
//   inject all CRM_ADAPTER_CONTRIBUTIONS (multi) → fold into CRM_ENTITY_SOURCES,
//   keyed (provider, entity). Collision on (provider,entity) is a boot error.
function provideCrmEntitySources(contribs: AdapterContribution[]): IEntityChangeSourceRegistry { /* fold */ }
```

**Relationship to Track C C7 `IEntityChangeSourceRegistry`.** `<SURFACE>_ENTITY_SOURCES` resolves to a C7 `IEntityChangeSourceRegistry` instance — Track D emits the *wiring* that populates it; C7 defines the *interface*. The orchestrator (integration subsystem) consumes the registry, agnostic to whether a source came from a hand-written adapter or a configured `PollChangeSource<T>` (ADR-033 primitive).

## 4. Adapter scaffold strategy

`<provider>-<surface>.adapter.ts` is **scaffolded once**, then author-owned.

**Emitted (first run only):**
- Class skeleton `export class <Provider><Surface>Adapter implements <Surface>Port` (L3 composing port, Track C C6).
- Constructor injection of: L1 strategies (the provider's declared auth strategy + client), L2 capability ports (per the surface's `<Surface>Capabilities`, Track C), and the entity sources registry.
- A `capabilities` literal whose `entities` is populated from `definitions/entities/*.yaml` filtered by `surface:` matching this surface — i.e. codegen knows which entities this adapter must source.
- Method **stubs** for the L2 ports (`fields.list()`, `picklists.values()`, `associations.list()` for CRM) that `throw new Error('not implemented')` — author fills bodies.
- A pass-through to `IEntityChangeSourceRegistry` for `sources`.

**NOT emitted:**
- L2 method bodies (provider-specific HTTP logic — author-owned).
- Surface-only methods (declared **optional** on `<Surface>Port`). *Resolved open question:* these are authored **inline in the adapter** (not a separate `<provider>-<surface>.surface-methods.ts` file). Rationale: a separate file adds a second author-owned artifact and an import dance for what is, by definition, provider-specific glue; keeping them inline keeps "everything the author owns for this provider-surface" in one file. The scaffold emits a commented `// surface-only methods (optional on <Surface>Port): add here` marker.

**Emit-once mechanism.** Scaffolds carry a sentinel header `// <CODEGEN-SCAFFOLD-V1>`. On re-emit, codegen detects the sentinel on an existing file and **skips** (logs `skipped scaffold <path> (author-owned)`). *Decision (confirming #339):* sentinel-based emit-once, not a manifest. The version suffix (`-V1`) lets a future codegen bump intentionally re-scaffold with a migration note if the scaffold shape changes; absent that, existing files are never touched.

## 5. Per-consumer typed view

`src/integrations/<surface>/types.generated.ts` — **fully codegen-owned, re-emitted every run.** Contains:
- `type <Surface>Provider = 'google' | 'gong' | …` (the providers whose `surfaces:` include this surface).
- `type <Surface>Entity = …` (entities with this `surface:`).
- A `(provider, entity)` validity map type so consumer use-cases get compile-time errors on bad pairings.

This is the **typed replacement for ADR-033.2's per-entity tuples** (§8) — surface-scoped instead of entity-scoped, and emitted from the provider registry rather than entity detection blocks. Adapter scaffolds do **not** import it (it's for consumer use-case code, not adapter internals).

## 6. Migration command — `cdp integrations migrate`

One-shot lift from the legacy layout to the new tree (no backwards-compat; old paths deleted).

- **Detect:** legacy layout present (`src/modules/*-sync-source.*` and/or `src/modules/integration-sync/<provider>/`) AND `definitions/providers/*.yaml` absent → migration applies. Both-present → partial state (below).
- **Operations:** lift hand-rolled poll-fetch callbacks into `src/integrations/<surface>/adapters/<provider>/`; rewrite imports; synthesize `definitions/providers/*.yaml` from existing `detection:` blocks + the hand-rolled strategy/client classes it can locate; delete legacy paths.
- **Idempotency:** subsequent runs are no-ops if the new layout already exists and the legacy paths are gone.
- **Dry-run default / `--apply`:** bare invocation prints the plan (files created / rewritten / deleted) and exits 0 without writing. `--apply` performs it.
- **Conflict handling (resolved open question):** if a target file already exists with content differing from what migrate would write → **abort with a diff** and a message naming the file; do not overwrite. *Partial-migration state* (some `definitions/providers/*.yaml` already exist) is treated as conflict-per-file, not a hard block: migrate processes the un-migrated providers and reports the already-present ones as skipped. This handles the already-merged consumer reorgs (integration-patterns #108–110) gracefully rather than requiring legacy-only input.

## 7. Snapshot fixture strategy

`pattern-stack/integration-patterns` is the reference consumer and the snapshot fixture. To avoid coupling the codegen repo to a sibling repo at test time, a **checked-in copy of the relevant YAML** lives at `test/fixtures/integration-patterns/definitions/{entities,providers}/*.yaml`; the test runs `cdp gen` against it and snapshots the emitted `src/integrations/**` tree. The fixture is refreshed by an explicit `just refresh-integration-fixture` recipe (copies current YAML from a local `integration-patterns` checkout), never auto-synced — so the snapshot is a deliberate, reviewed artifact. (Mirrors the existing baseline-snapshot discipline; note per the team's standing rule that baseline covers clean-arch only — these provider/adapter emissions need their **own** template-emission tests, not just baseline.)

## 8. Relationship to existing codegen (what's superseded / deprecated / kept)

| prior decision | disposition | when |
|---|---|---|
| **ADR-034** project-level provider registry in `codegen.config.yaml` `providers:` | **Superseded** by `definitions/providers/*.yaml` (§1). Mark ADR-034 `Superseded`, forward-point here. | D1 (schema) |
| **ADR-033.2** per-entity typed tuples `<entity>-sync-source.providers.ts` | **Deprecated → removed.** Replaced by §5 surface-scoped `types.generated.ts`. No parallel sources of provider truth. | removed in **D4** (when the registry + typed view land), per locked decision 2 |
| **ADR-033 / 033.1** `detection:` blocks + `DetectionConfig` | **Kept.** Still the per-entity field-mapping & cursor config. Only the *provider roster* leaves entity YAML (moves to `definitions/providers/`). `detection:` keys are validated as ⊆ the providers whose `surfaces:` include the entity's surface. | unchanged |
| per-entity `<entity>-sync-source.module.ts` emit | **Retargeted** into the `src/integrations/<surface>/adapters/` tree. | D2–D3 |
| ADR-031 auth subsystem (`ConnectionStore` etc.) | **Kept / consumed.** Provider `auth.strategy` classes implement the auth subsystem's strategy contract; provider modules wire them. | unchanged |

## Open questions — resolved in this RFC

1. **Provider YAML location** → `definitions/providers/` (locked decision 3).
2. **Surface-only methods on the composing port** → authored **inline** in the adapter scaffold (§4), declared optional on `<Surface>Port`, not codegen-emitted, not a separate file.
3. **Strategy/client import-path verification** → **pre-flight** at codegen time (§1).
4. **`migrate` vs partial state** → per-file conflict handling with dry-run default + abort-with-diff (§6); no legacy-only requirement.

## Sequencing (D1–D7, post-RFC)

- **D1** — `definitions/providers/*.yaml` schema + validator (incl. pre-flight import check, surface cross-check). Mark ADR-034 superseded.
- **D2** — provider module emission (`<provider>.provider.module.ts`).
- **D3** — adapter module + barrel + `<surface>-adapters.module.ts` aggregator emission (retarget existing).
- **D4** — registry tokens (§3) + `types.generated.ts` (§5); **remove ADR-033.2 tuple emission**.
- **D5** — `cdp integrations migrate` (§6).
- **D6** — adapter scaffold emit-once (§4) + sentinel handling.
- **D7** — snapshot fixture (§7) + template-emission test suite.

**Dependencies:** D3/D4/D6 require Track C **C0** (surface-package convention, #329) and **C6** (`CrmPort` / `<Surface>Port` composing port). D1/D2/D5 are independent of Track C and can start as soon as this RFC merges.

## Deliverable

This file, merged before D1 begins. Subsequent deviations require a fresh review round.

[#338]: https://github.com/pattern-stack/codegen-patterns/issues/338
[#339]: https://github.com/pattern-stack/codegen-patterns/issues/339
