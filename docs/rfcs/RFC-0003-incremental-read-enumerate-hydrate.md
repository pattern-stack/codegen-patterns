# RFC-0003 — `IncrementalRead`: enumerate/hydrate read primitive + the scaffold body it emits (Track D round-3)

**Status:** Draft — pending Gate 1.5 critique
**Date:** 2026-05-31
**Owner:** Doug
**Related:** RFC-0001 (provider/adapter emission — *this RFC reshapes the read-side `changeSources` body it emits*), RFC-0002 (module assembly emission — **disjoint surface; composes, does not collide — see §6**), ADR-033/033.1 (`detection:` config + `PollChangeSource`), Track C #329 (surface packages), swe-brain ADR-0002/ADR-0003 (the capability-primitive model this promotes), `runtime/subsystems/integration/` (the `IChangeSource` / `PollChangeSource` / orchestrator this builds on).

## Goal

Today the read-side author-seam is a bare `changeSources: Record<string, IChangeSource<unknown>> = {}` (RFC-0001 §4, `adapter-emission-generator.ts:308`) — the author hand-writes a `listChanges` async generator per entity, with no structure imposed. Every swe-brain adapter that filled it did the same wrong thing: **fetch everything into an array, then return** — buffer-all, serial, one run-final cursor. The result is the email-sync regression (21k messages / 40.5 min / serial `messages.get`) and a latent data-loss bug (a mid-backfill failure persists the run-final cursor and silently skips the un-hydrated tail).

This RFC introduces **`IncrementalRead<T, F>`** — a universal read capability whose providing base decomposes the read into two composable verbs:

- **`enumerate(mode, filter) → AsyncIterable<Ref>`** — the cheap delta/backfill walk; streams lightweight refs (id + per-ref cursor + filterable metadata).
- **`hydrate(ids) → Map<id, raw>`** — the expensive fetch-by-id, batched; where bounded concurrency / vendor `/batch` lives.

The base owns the orchestration (drain, pre-hydrate filter placement, bounded-concurrency hydrate, `SourcedRecord` pairing, per-ref cursor emission) and produces a streaming `IChangeSource<T>`. **Codegen emits the base subclass as the read-side scaffold**, so the author fills only `enumerate` / `hydrate` / `toCanonical` — never a raw `listChanges` generator, never a buffer-all loop. The shape is the generalization of dealbrain's proven HubSpot adapter (`listSince`: streams, pushes filter server-side, per-record cursor) to vendors whose list returns id-stubs or nested resources.

## Context — why the current seam produces the wrong code

`IChangeSource.listChanges` is the right *transport* contract (streaming `AsyncIterable<Change<T>>`, two-arg, orchestrator owns cursor lifecycle). The gap is one level down: **nothing guides how the body that produces those changes is written.** An empty `changeSources` container invites the author to materialize a batch and yield it — which defeats the streaming the orchestrator and `PollChangeSource` already provide.

### The motivating evidence — three read shapes, one wrong abstraction

swe-brain's three Google adapters have three *different* read shapes, and the current single-verb seam fits none of them well:

| Entity | Vendor read | Shape | Current cost |
|---|---|---|---|
| Email (Gmail) | `messages.list` → id-stubs, then `messages.get` **per id** | **N+1** | 21k serial gets, ~40 min |
| Meeting (Calendar) | `events.list` returns **full** objects | no hydrate | fine — but accidentally |
| Transcript (Meet) | `conferenceRecords.list` → per-record `transcripts.list` → per-transcript `entries.list` | **nested N+1** | serial nested drain |

The proven reference — dealbrain HubSpot `canonical-adapter.listSince` — never hit this because CRM's search endpoint returns full objects (like Calendar): it already **streams** (`async *`), **pushes the filter server-side** (`filterGroups` + `GT`), and carries a **per-record cursor** (`systemModstamp`). swe-brain regressed from that shape on all three axes. The genuinely new axis swe-brain needs — and the one this RFC adds — is the **enumerate/hydrate split**, so the primitive absorbs Gmail's stub-list and Meet's nested-list as cleanly as it absorbs Calendar/CRM's full-object list (where `hydrate` is a passthrough).

## 1. The capability — `IncrementalRead<T, F>` + `RandomRead<T>`

Lives in `runtime/subsystems/integration/` beside `IChangeSource` / `PollChangeSource`, exported from `@pattern-stack/codegen/subsystems`. Vendor- and domain-agnostic; this is the framework owning the primitive (swe-brain ADR-0003's universal tier, promoted upstream).

```ts
export type ReadMode =
  | { kind: 'delta';     cursor: unknown }       // incremental
  | { kind: 'full';      since?: Date }          // backfill — the cursorless MODE, not a separate verb
  | { kind: 'reconcile'; knownIds: string[] };   // gap-repair (fixes the silent-tail-skip)

/** A cheap ref from the enumerate pass: identity + per-ref cursor + metadata to filter/display on. */
export interface Ref<M = Record<string, unknown>> {
  readonly externalId: string;
  readonly cursor: unknown;   // position AS OF this ref (see §3 divisibility)
  readonly meta: M;
}

export interface ReadRequest<F> {
  readonly mode: ReadMode;
  readonly filter?: F;
  readonly pageSize?: number;
}

export interface IncrementalRead<T, F = unknown> {
  read(req: ReadRequest<F>): AsyncIterable<SourcedRecord<T>>;   // the one public verb — streams
}

export interface RandomRead<T> {
  get(id: string): Promise<T | null>;                          // the atom hydrate is built from (§2)
}
```

## 2. The providing base — what's PROVIDED vs SUPPLIED

```ts
export abstract class IncrementalReadBase<T, F = unknown, M = Record<string, unknown>>
  implements IncrementalRead<T, F>, IChangeSource<T> {

  abstract readonly label: string;
  protected readonly filterPushdown: boolean = false;   // declared; surfaced to manifest/falsifier (§4)

  // ---- SUPPLIED by the adapter (the irreducible vendor seam) ----
  protected abstract enumerate(mode: ReadMode, filter?: F): AsyncIterable<Ref<M>[]>;  // LAZY (§3)
  protected abstract hydrate(ids: string[]): Promise<Map<string, unknown>>;           // keyed, miss-tolerant
  protected abstract toCanonical(raw: unknown): T | null;

  // Optional filter hooks — exactly one is live, decided by filterPushdown:
  protected matchesRef(_ref: Ref<M>, _f?: F): boolean { return true; }    // pre-hydrate (cheap) — preferred
  protected matchesRecord(_rec: T, _f?: F): boolean { return true; }      // post-hydrate (floor — Gmail w/o q=)

  // ---- PROVIDED by the base ----
  async *read(req: ReadRequest<F>): AsyncIterable<SourcedRecord<T>> {
    for await (const refPage of this.enumerate(req.mode, req.filter)) {     // pull-driven → backpressure
      const kept = refPage.filter((r) => this.matchesRef(r, req.filter));   // FILTER BEFORE HYDRATE
      const raws = await this.hydrate(kept.map((r) => r.externalId));       // bounded-parallel / vendor /batch
      for (const ref of kept) {
        const raw = raws.get(ref.externalId);
        if (raw === undefined) continue;                                    // deleted mid-run → skip, never fabricate
        const record = this.toCanonical(raw);
        if (record && this.matchesRecord(record, req.filter)) {
          yield { record, raw, cursor: ref.cursor };
        }
      }
    }
  }

  // Default hydrate when the adapter implements RandomRead: bounded-parallel map over get().
  // Adapters override ONLY for a real batch endpoint (Gmail /batch) or a passthrough (Calendar).
  // listChanges() adapts read() → Change<T> (operation: 'updated'; orchestrator classifies create/update;
  // delete via tombstone refs), reusing PollChangeSource's externalId/cursor stamping.
}
```

Three concerns the base settles (each a pressure-test finding):

- **Filter placement is structural, not disciplinary.** The base applies the filter *before* `hydrate`, so an adapter physically cannot hydrate-then-discard. When the vendor can neither push the predicate down nor expose filterable metadata in `enumerate` (Gmail without `q=`), the floor is `matchesRecord` (post-hydrate) — and that case is *declared* via `filterPushdown: false`, not silent. This answers the standing objection: "force the adapter to honor the filter" without the 21k-hydrate-to-keep-200 trap.
- **`hydrate` is keyed and miss-tolerant** (`Map<id, raw>`, not a positional array) — a single mid-run 404 (deleted message) can't shift alignment.
- **`hydrate` collapses into `RandomRead`** — the base provides a default `hydrate = bounded-parallel map over this.get` for adapters that implement `RandomRead`; only batch/passthrough vendors override. This is why `RandomRead` graduates to a real primitive: it's the atom, used in every incremental adapter, not a CRM nicety.

## 3. Cursor divisibility (the per-ref checkpoint, honestly scoped)

Per-ref cursors fix the silent-tail-skip — a crash at page 80 of a backfill resumes at page 80 — **but only when the cursor is divisible.** Divisibility is a property of the cursor strategy, not the primitive:

- **Divisible** — sortable-field watermarks (HubSpot `systemModstamp`, any `timestamp`/`system-modstamp` strategy). `enumerate` stamps a real per-ref cursor; the base/orchestrator may checkpoint mid-run.
- **Atomic** — opaque vendor tokens (Gmail `historyId`, Calendar `syncToken`). The next watermark only exists at end-of-walk; an interrupted *delta* run stays all-or-nothing (acceptable — deltas are small). Full/reconcile backfills over these vendors checkpoint by **window/page**, not by token.

**Scope:** add a `divisible: boolean` (or a `checkpoint(refs)` capability) to the cursor-strategy interface so the base knows when per-ref checkpointing is safe versus when to fall back to per-window. The orchestrator's existing advance-on-yield / persist-on-success lifecycle is unchanged; it simply honors the strategy's divisibility.

## 4. What codegen emits (the scaffold reshape)

`generateAdapterScaffold` (`adapter-emission-generator.ts:227`) changes its read-side body. Today it emits one class with an empty `changeSources = {}`. After this RFC, per entity in `capabilities.entities` it emits an **emit-once `IncrementalReadBase` subclass** and registers it:

```ts
// <CODEGEN-SCAFFOLD-V1>   ← still emit-once; regen skips if present
export class GoogleEmailIncrementalRead
  extends IncrementalReadBase<CanonicalEmail, EmailFilter, EmailRefMeta> {
  readonly label = 'google-mail-email';
  protected override filterPushdown = true;                 // Gmail q= takes the predicate

  protected async *enumerate(mode, filter) { /* TODO: messages.list / history.list → Ref pages */ }
  protected async hydrate(ids)  { /* TODO: messages.get (override: /batch) → Map<id, raw> */ }
  protected toCanonical(raw)    { /* TODO: External(Zod) → CanonicalEmail */ }
}
```

and the adapter's container becomes:

```ts
readonly changeSources: Record<string, IChangeSource<unknown>> = {
  email: new GoogleEmailIncrementalRead(this.auth, this.client),   // construction site (composes RFC-0002 §3 Option A)
};
```

Unchanged: the emit-once sentinel + skip-on-regen, the `@Injectable` adapter `implements <Port>`, the `capabilities` literal, the `auth`/`client` injection (post-E0 — no registry arg). The `filterPushdown` flag flows into the manifest so the falsifier suite can assert *"emits only records matching the filter"* and record which adapters filter post-hydrate.

**Filter source:** `DetectionConfig.filters` (already parsed → `ResolvedFilter[]`, already handed to the poll callback as `ctx.filters`) maps to `ReadRequest.filter`. The discipline this RFC adds is *where* it's applied (pre-hydrate) and *whether the vendor pushed it down* (the flag) — the hook already exists.

## 5. Modes, not methods (anti-pattern guard)

`backfillAll` and `backfillMissing` are **not** new verbs (swe-brain ADR-0003: mode ≠ capability). They are `ReadMode` values: `full` (cursorless), `delta` (cursored), and the new `reconcile` (gap-repair — re-fetch a known id set the cursor skipped). `reconcile` is the repair pass for the silent-tail-skip and for #414-style multi-provider divergence later. One `read()` verb; three modes.

## 6. Relationship to RFC-0002 — disjoint, composes, no collision

RFC-0002 declares the read-side body **out of its own scope** twice: §1 *"Unchanged author-seam: the `IChangeSource.listChanges` fetch body inside the adapter scaffold's `changeSources`"*; §6 *"adapter scaffold `changeSources` (author fills the `IChangeSource` bodies) — Kept."* RFC-0002 builds the **assembly** (sink, per-entity `ExecuteIntegrationUseCase`, module packaging, aggregator, tokens) *around* `adapter.changeSources['<entity>']`, consuming it as an opaque `IChangeSource`. This RFC reshapes **what's inside** that seam.

- **Different altitudes of the same emitter.** RFC-0002 wires the box; RFC-0003 shapes the box's contents. The assembly binds `INTEGRATION_CHANGE_SOURCE = adapter.changeSources['<entity>']` regardless of how the body is authored.
- **Shared file already de-conflicted.** Both touch `generateAdapterScaffold`. RFC-0002's only change there is **E0** (drop the `IEntityChangeSourceRegistry` injection) — **already landed** (`6e77e49`). RFC-0003 builds on the post-E0 scaffold; E1–E4 add new files and don't re-touch the body.
- **RFC-0003 reinforces RFC-0002 §3.** §3 resolved to Option A ("source built once, single construction site"). With the body an `IncrementalReadBase` subclass, the `changeSources['<entity>']` entry *is* the single construction — Option A becomes true at the type level.
- **"Migrate once" binds the release.** Both reshape the shape swe-brain migrates against. Ship **both in the 0.13 train** (RFC-0002 assembly + RFC-0003 read body) so swe-brain regenerates and fills bodies exactly once. swe-brain may prototype the three hook bodies now (they move verbatim), but consumption waits for the combined 0.13 shape.

## 7. Open questions — for Doug

1. **Capability home.** `IncrementalRead`/`RandomRead`/base in `@pattern-stack/codegen/subsystems` (beside `IChangeSource` — *recommended*, matches "codegen owns it") vs the surface-package framework. Recommendation: subsystems — it's runtime, vendor-agnostic, and produces an `IChangeSource`.
2. **`enumerate` ref granularity.** Minimal (`{externalId, cursor}` only) vs **rich** (`Ref<M>` with metadata) — *recommended rich*, since pre-hydrate filtering and a future "query-surface lists cheaply, fills on click" both need metadata. Cost: a domain `M` type per surface (lives in the consumer / surface package).
3. **Cursor-divisibility surface (§3).** A `divisible: boolean` flag on the cursor strategy vs a richer `checkpoint(refs)` method. Recommendation: start with the flag; promote to a method only if a vendor needs custom checkpoint granularity.
4. **`reconcile` mode scope.** Land the enum value + base support now, or defer the gap-repair driver until the silent-tail-skip fix is prioritized? Recommendation: land the enum + `enumerate(mode='reconcile')` contract now (cheap); a scheduled reconcile runner is a separate consumer concern.

## 8. Snapshot + tests

Extend the RFC-0001 §7 / RFC-0002 §8 integration-emission snapshot fixture (`test/fixtures/integration-patterns/`) to assert the reshaped read-side scaffold (per-entity `IncrementalReadBase` subclass + `changeSources` registration). Add a **falsifier** assertion keyed off `filterPushdown`: a conforming adapter emits only records matching the request filter, regardless of pushdown. Per the standing rule (memory `project_baseline_clean_arch_only`): template-emission tests, not baseline.

## Sequencing (post-RFC, after Gate 1.5)

- **R1** — land `IncrementalRead`/`RandomRead`/`IncrementalReadBase` in `runtime/subsystems/integration/` + export from `@pattern-stack/codegen/subsystems`; unit-test the base (drain, pre-hydrate filter, keyed/miss-tolerant hydrate, default-hydrate-over-get, per-ref cursor). No emitter change yet — pure runtime addition, parallel to RFC-0002 E1–E4.
- **R2** — cursor-strategy divisibility (§3): add the flag; base/orchestrator honor it.
- **R3** — reshape `generateAdapterScaffold` read-side body (§4): emit the per-entity `IncrementalReadBase` subclass + `changeSources` registration; thread `DetectionConfig.filters` → `ReadRequest.filter`; surface `filterPushdown` into the manifest. Rebaseline the emission snapshot.
- **R4** — falsifier assertion (§8) + docs (integration skill `protocols-and-ports.md`: the enumerate/hydrate authoring recipe, HubSpot `listSince` as the north star).
- **Release** — ship R1–R4 in **0.13 alongside RFC-0002 E1–E4** (one consumer-facing shape).

## Deliverable

After 0.13: codegen emits an integration that is correct-by-construction on the read path — streaming, bounded-parallel hydration, filter-before-hydrate, per-ref checkpointing where the cursor allows — and the author fills exactly three vendor methods (`enumerate` / `hydrate` / `toCanonical`) plus any non-generic sink write logic. The buffer-all/serial/run-final-cursor regression becomes structurally unwritable. swe-brain consumes it in one regen (RFC-0002 assembly + RFC-0003 read body together), deleting the hand-rolled `pullX` ports and `*_integration` modules.

## Spec Review (Gate 1.5 critique)

_Pending — run `/sdlc:critique` (lens=mixed, against `adapter-emission-generator.ts` + `runtime/subsystems/integration/*` + the swe-brain reference adapters) before R1._
