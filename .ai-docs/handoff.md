# Handoff — 2026-05-31 — Track D round-2 (B) + swe-brain integration migration

**Branch:** `main` (at `412bd2a` — 0.12.2 merged).
**Pairs with:** swe-brain `.ai-docs/handoff.md` (thread #4) +
`.ai-docs/handoff-swe-brain-integration-codegen-migration.md`. The next session
**combines these two workstreams** (codegen-patterns = produce; swe-brain =
consume) into one path forward.

> Prior May-12 handoff (junction wave-1, PRs #359/#361/#58–#63) is fully
> resolved and lives in git history — intentionally replaced, not lost.

## Where codegen-patterns is

Released train (Track C/D integration codegen):
- `0.12.0` (#421) — Track C/D: provider/adapter/surface integration codegen + surface packages. **Published.**
- `0.12.1` (#423) — CLI **discoverability**: `entity new --help` documents the Track D post-step, `entity` summary surfaces a Track D hint when a providers dir exists, integration skill documents the invocation. **Published.**
- `0.12.2` (#426) — consumer-CLI **fixes**: `surface:`/`context:` accepted **inside the `entity:` block**; entity discovery **excludes `definitions/providers/`** (was globbed + validated as entities); `entity new --dry-run` surfaces Zod detail. **MERGED to main (412bd2a), NOT yet published — only Doug can `just publish`.**

⚠️ **Publish is pending.** swe-brain currently consumes 0.12.2 via a **local
bun-link** to a codegen-patterns worktree, not npm. After `just publish`,
swe-brain re-pins to `@pattern-stack/codegen@0.12.2` + `bun install` (un-links).
Per memory `feedback_post_publish_smoke_gap`: repo-checkout smoke does NOT catch
tarball/files-manifest bugs — verify the published 0.12.2 tarball functionally
(`npm pack` + install + run), as was done for 0.12.1.

## The decision: pursue B (Track D round-2 — emit the module assembly)

Track D today emits the **read side only**: provider module + adapter scaffold
(`changeSources` container) + per-surface aggregator/registry + `types.generated.ts`.
It does **NOT** emit the **assembly**: the `INTEGRATION_SINK` binding, the
`ExecuteIntegrationUseCase`/orchestrator wiring, and the per-entity/surface
feature-module packaging. swe-brain's hand-authored `<x>_integration` module
*had* that assembly — it was the inspiration; RFC-0001 captured the
decomposition (ports/registry) but not the assembly. **That omission was a scope
artifact, not a deliberate "no modules" call.**

**B = extend codegen so YAML generates the combinable per-adapter module incl.
sink-binding + per-surface `ExecuteIntegrationUseCase` wiring.** "Module pattern"
becomes the generated artifact, fully YAML-driven. The goal is BOTH the
combinable per-adapter module AND maximal YAML-driving — they are not opposed.
This is the faithful completion of "swe-brain inspires upstream."

**Irreducible author-seam (unchanged by B):** the `IChangeSource` **fetch body**
(vendor API logic) + any **non-generic write logic**. Everything around it
(module, wiring, sink-binding over the generated repo's `integrationUpsert`,
orchestrator, registry, typed views) is generatable.

### B RFC — DRAFTED: `docs/rfcs/RFC-0002-integration-module-assembly-emission.md`

Written this session, grounded in the real runtime + swe-brain's proven module.
It extends RFC-0001 §2 to also emit, per (surface, provider, entity):
- `<surface>/modules/<provider>/<entity>-integration.module.ts` (@generated assembly),
- `<surface>/sinks/<entity>.sink.ts` (emit-once default sink over the generated repo),
- `<surface>/<surface>-integration.module.ts` (@generated aggregator),
- `<surface>/<surface>-integration.tokens.ts` (the `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` tokens).

The reference shape is swe-brain's `transcript-integration.module.ts` (per-entity
module binding `INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK`, local
`ExecuteIntegrationUseCase` aliased under a unique token; substrate from the
global `forRoot`). Author-seam stays: `IChangeSource.listChanges` fetch body +
non-generic sink write logic.

**Open questions in the RFC needing Doug's resolve before implementation (§3/§7):**
1. **§3 — source-binding strategy.** Option A (bind from `adapter.changeSources['<entity>']`, faithful to swe-brain — *recommended*) vs Option B (registry + `sourceOverride` runner). The orchestrator (`execute-integration.use-case.ts`) is DI-bound to ONE source/sink per instance but accepts `sourceOverride` — that's the fork.
2. Sink override mechanism (emit-once scaffold vs abstract base + subclass).
3. Multi-provider #414 — proposed defer (Option A is one-provider-per-module).
4. Token naming/casing.

### Design items B MUST settle (don't let them drift again)

1. **`surface:`/`context:` placement — RATIFY or revisit.** 0.12.2 moved both
   *into* the `entity:` block (Doug's call: "ship #426 as-is, B ratifies"). This
   created an **asymmetry**: `surface:`/`context:` now live in `entity:`, while
   the *other* declarative blocks — `detection:`, `events:`, `emits:`,
   `queries:` — all stay at **root**. B is the deliberate venue to either (a)
   confirm `entity:`-block placement and document why surface/context differ from
   the sibling blocks, or (b) define one consistent rule. Pick on purpose; do not
   leave it as a hotfix default.
2. **The `IChangeSource` contract is the authoring reference** for whatever B
   emits. Verified on main
   (`runtime/subsystems/integration/integration-change-source.protocol.ts`):
   ```ts
   interface IChangeSource<T> {
     readonly label: string;
     listChanges(subscription: IntegrationSubscriptionView, cursor: unknown | null): AsyncIterable<Change<T>>;
   }
   interface Change<T> { externalId; operation: 'created'|'updated'|'deleted'; record: T; cursor: unknown; source: ChangeSource; dedupKey?; providerChangedFields? }
   ```
   `listChanges` is **two args** (subscription first), returns an
   **async-iterable of `Change<T>`** (not a `SourcedRecord[]` batch), and
   requires a `label`. The swe-brain handoff §4a still describes it as
   single-arg `listChanges(cursor)` — corrected there in a dated addendum; B's
   generated bodies/stubs MUST match the real signature.
3. **#414 — multi-provider registry.** The per-surface entity-source registry
   can't represent the same entity from two providers (Google + Gong
   transcripts) — entity-keyed, throws on collision. Single-provider is fine
   today; B should decide whether assembly emission addresses or defers this.
4. **Optional: typed `registry.get` accessor** (filed enhancement). L1
   `registry.get(entityName: string)` is `string` by design; a generated typed
   accessor off `<Surface>Entity` removes the call-site annotation burden.

## Path: B-first — DECIDED (no A interim)

Doug chose **B-first** ("do it right once") over the A interim. Rationale: the
hand-rolled integration layer still runs in production (transcript fetch #24 is
live on it), so nothing goes dark while B is built — there's no production gap to
bridge, which was the only reason to do A. The migration branch
`feat/integration-codegen-migration` stays a **proof-of-concept**; do NOT pour
vendor-body porting into the current scaffold shape, because B reshapes what the
adapter scaffold emits and you'd regenerate anyway. swe-brain migrates ONCE,
against the final B shape.

## Immediate next actions

1. **Resolve RFC-0002's open questions** (§3 source-binding A/B, §7) with Doug,
   then merge the RFC.
2. **Publish 0.12.2** (`just publish`, Doug) → functionally verify the tarball →
   swe-brain re-pins off the bun-link. (Independent of B; good hygiene.)
3. **Implement B** per RFC-0002 sequencing E1–E4 (sink emitter → assembly module
   → aggregator → snapshot tests), ship as 0.13.
4. **swe-brain consumes (E5):** regen against 0.13, fill fetch bodies + sink
   overrides, delete hand-rolled `src/modules/{email,meeting,transcript}_integration`
   + `packages/ports/*` + `packages/surfaces/interaction`.

## Pointers
- This session's work: #423 (CLI help/skill), #426 (consumer-CLI fixes). The
  `entity new` Track D post-step lives in `src/cli/commands/entity.ts`
  (`EntityNewCommand.execute()`); adapter scaffold emitter in
  `src/cli/shared/adapter-emission-generator.ts`.
- Integration skill (auto-triggers under `runtime/subsystems/integration/`):
  `.claude/skills/integration/` — `protocols-and-ports.md` has the "Driving
  Track D codegen" section + the port contracts.
