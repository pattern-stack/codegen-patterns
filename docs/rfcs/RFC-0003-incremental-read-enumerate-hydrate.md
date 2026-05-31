# RFC-0003 — `IncrementalRead`: enumerate/hydrate read primitive + the scaffold body it emits (Track D round-3)

**Status:** Accepted — Gate 1.5 PASS_WITH_NOTES (rev 2); R1+R2+R3 landed (R4 pending; see Sequencing)
**Date:** 2026-05-31
**Owner:** Doug
**Related:** RFC-0001 (provider/adapter emission — *this RFC reshapes the read-side `changeSources` body it emits*), RFC-0002 (module assembly emission — **disjoint surface; composes, does not collide — see §6**), ADR-033/033.1 (`detection:` config + `PollChangeSource`), Track C #329 (surface packages), swe-brain ADR-0002/ADR-0003 (the capability-primitive model this promotes), `runtime/subsystems/integration/` (the `IChangeSource` / `PollChangeSource` / orchestrator this builds on).

## Goal

Today the read-side author-seam is a bare `changeSources: Record<string, IChangeSource<unknown>> = {}` (RFC-0001 §4, `src/cli/shared/adapter-emission-generator.ts:311`) — the author hand-writes a `listChanges` async generator per entity, with no structure imposed. Every swe-brain adapter that filled it did the same wrong thing: **fetch everything into an array, then return** — buffer-all, serial, one run-final cursor. The result is the email-sync regression (21k messages / 40.5 min / serial `messages.get`) and a latent data-loss bug (a mid-backfill failure persists the run-final cursor and silently skips the un-hydrated tail).

This RFC introduces **`IncrementalRead<T, F>`** — a universal read capability whose providing base decomposes the read into two composable verbs:

- **`enumerate(mode, filter) → AsyncIterable<Ref>`** — the cheap delta/backfill walk; streams lightweight refs (id + per-ref cursor + filterable metadata).
- **`hydrate(ids) → Map<id, raw>`** — the expensive fetch-by-id, batched; where bounded concurrency / vendor `/batch` lives.

The base owns the orchestration (drain, pre-hydrate filter placement, bounded-concurrency hydrate, `SourcedRecord` pairing, per-ref cursor emission) and produces a streaming `IChangeSource<T>`. **Codegen emits the base subclass as the read-side scaffold**, so the author fills only `enumerate` / `hydrate` / `toCanonical` — never a raw `listChanges` generator, never a buffer-all loop. The shape is the generalization of dealbrain's proven HubSpot adapter (`listSince`: streams, pushes filter server-side, per-record cursor) to vendors whose list returns id-stubs or nested resources.

## Context — why the current seam produces the wrong code

`IChangeSource.listChanges` is the right *transport* contract (streaming `AsyncIterable<Change<T>>`, two-arg, orchestrator owns cursor lifecycle). The gap is one level down: **nothing guides how the body that produces those changes is written.** An empty `changeSources` container invites the author to materialize a batch and yield it — which defeats the streaming the orchestrator and `PollChangeSource` already provide.

### The motivating evidence — three read shapes, one wrong abstraction

> _External evidence — not in this repo._ The swe-brain adapters and the dealbrain HubSpot reference below live in their own repos; they are not greppable from this branch. They motivate the design but are not citation targets for implementation.

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

/** NET-NEW (R1). The read()-side envelope: external id + canonical record + the raw vendor
 *  payload it came from + the per-ref cursor. Distinct from the runtime's existing transport
 *  envelope `Change<T>` (operation/externalId/cursor/source). One-directional: `listChanges()`
 *  adapts `read()` → `Change<T>` (§2), dropping `raw` and stamping `operation`/`source`.
 *  `read()` keeps `externalId` + `raw` so a query surface can re-project without a second fetch.
 *  (R1 refinement: `externalId` is carried — `listChanges` needs it to stamp `Change.externalId`
 *  without re-deriving it from the record via a mapping.) */
export interface SourcedRecord<T> {
  readonly externalId: string;
  readonly record: T;
  readonly raw: unknown;
  readonly cursor: unknown;
}

export interface IncrementalRead<T, F = unknown> {
  read(req: ReadRequest<F>): AsyncIterable<SourcedRecord<T>>;   // the one public verb — streams
}

export interface RandomRead<T> {
  get(id: string): Promise<T | null>;                          // provided by the base, §2
}
```

All four types above are **net-new in R1**; only `Change<T>` / `IChangeSource<T>` / `PollChangeSource` exist in `runtime/subsystems/integration/` today.

## 2. The providing base — what's PROVIDED vs SUPPLIED

```ts
export abstract class IncrementalReadBase<T, F = unknown, M = Record<string, unknown>>
  implements IncrementalRead<T, F>, IChangeSource<T> {

  abstract readonly label: string;
  protected readonly filterPushdown: boolean = false;   // declared; surfaced to manifest/falsifier (§4)

  // ---- SUPPLIED by the adapter (the irreducible vendor seam) ----
  protected abstract enumerate(mode: ReadMode, filter?: F, pageSize?: number): AsyncIterable<Ref<M>[]>;  // LAZY (§3); pageSize bounds atomic blast-radius
  protected abstract hydrate(ids: string[]): Promise<Map<string, unknown>>;           // keyed, miss-tolerant
  protected abstract toCanonical(raw: unknown): T | null;

  // Optional filter hooks — exactly one is live, decided by filterPushdown:
  protected matchesRef(_ref: Ref<M>, _f?: F): boolean { return true; }    // pre-hydrate (cheap) — preferred
  protected matchesRecord(_rec: T, _f?: F): boolean { return true; }      // post-hydrate (floor — Gmail w/o q=)

  // ---- PROVIDED by the base ----
  async *read(req: ReadRequest<F>): AsyncIterable<SourcedRecord<T>> {
    for await (const refPage of this.enumerate(req.mode, req.filter)) {     // pull-driven → backpressure
      const kept = refPage.filter((r) => this.matchesRef(r, req.filter));   // FILTER BEFORE HYDRATE
      if (kept.length === 0) continue;
      const raws = await this.hydrate(kept.map((r) => r.externalId));       // bounded-parallel / vendor /batch
      for (const ref of kept) {
        const raw = raws.get(ref.externalId);
        if (raw === undefined || raw === null) continue;                    // deleted mid-run → skip, never fabricate
        const record = this.toCanonical(raw);
        if (record !== null && this.matchesRecord(record, req.filter)) {
          yield { externalId: ref.externalId, record, raw, cursor: ref.cursor };
        }
      }
    }
  }

  // RandomRead provided FOR FREE as `toCanonical ∘ hydrate([id])` — every incremental adapter
  // is a single-record reader (the "list cheaply, fill on click" need) with no extra code.
  async get(id: string): Promise<T | null> { /* hydrate([id]) → toCanonical, null on miss */ }

  // listChanges() adapts read() → Change<T> (operation: 'updated'; orchestrator classifies
  // create/update; delete via tombstone refs); honors cursorDivisible (§3) when emitting cursors.
}
```

**R1 refinement — `get` is built from `hydrate`, not the reverse.** The RFC originally framed `hydrate` as a default provided over `RandomRead.get`. Implementation inverted this for coherence: `hydrate(ids) → Map<id, raw>` is the irreducible vendor seam (one of the three abstract methods — matches the Deliverable's "fill exactly three vendor methods"), and `get` (RandomRead) is *provided* by the base as `toCanonical ∘ hydrate([id])`. This resolves the raw-vs-canonical conflation (hydrate yields raw; `get`/`read` yield canonical) and gives every adapter a free single-record reader. A `mapConcurrent(ids, fetchOne, limit)` helper ships alongside so writing a batched `hydrate` over a single-id fetch is one line; batch vendors (Gmail `/batch`) or passthroughs (Calendar) write `hydrate` directly.

Three concerns the base settles (each a pressure-test finding):

- **Filter placement is structural, not disciplinary.** The base applies the filter *before* `hydrate`, so an adapter physically cannot hydrate-then-discard. When the vendor can neither push the predicate down nor expose filterable metadata in `enumerate` (Gmail without `q=`), the floor is `matchesRecord` (post-hydrate) — and that case is *declared* via `filterPushdown: false`, not silent. This answers the standing objection: "force the adapter to honor the filter" without the 21k-hydrate-to-keep-200 trap.
- **`hydrate` is keyed and miss-tolerant** (`Map<id, raw>`, not a positional array) — a single mid-run 404 (deleted message, a `null`/absent entry) can't shift alignment.
- **`RandomRead` is provided, not required.** The base satisfies `RandomRead<T>.get` for free from `hydrate` + `toCanonical`, so `RandomRead` graduates to a real primitive (the single-record atom every incremental adapter exposes) without the adapter writing it.

## 3. Cursor divisibility (the per-ref checkpoint, honestly scoped)

Per-ref cursors fix the silent-tail-skip — a crash at page 80 of a backfill resumes at page 80 — **but only when the cursor is divisible.** Divisibility is a property of the cursor strategy, not the primitive:

- **Divisible** — sortable-field watermarks (HubSpot `systemModstamp`, the existing `timestamp` / `systemModstamp` `kind`s). `enumerate` stamps a real per-ref cursor; the base/orchestrator may checkpoint mid-run.
- **Atomic** — opaque vendor tokens (Gmail `historyId`, Calendar `syncToken`). The next watermark only exists at end-of-walk; an interrupted *delta* run stays all-or-nothing (acceptable — deltas are small). Full/reconcile backfills over these vendors checkpoint by **window/page**, not by token.

**Today's reality:** `CursorStrategy` (`src/.../detection-config.schema.ts`, the `detection:` config) is a **Zod discriminated union of inert config shapes** (`kind: 'systemModstamp' | 'replayId' | 'timestamp' | 'eventId'`), not a behavioral interface — so a `checkpoint(refs)` *method* cannot live on it. Two of the §3 examples are **net-new kinds**: Gmail `historyId` and Calendar `syncToken` have no schema entry today; the opaque-token (atomic) side of the split must be added, not merely "honored."

**Scope (R2), revised per critique:**
1. Add the missing atomic `kind`s (`historyId`, `syncToken`) to the `CursorStrategy` union.
2. Add divisibility as a **predicate keyed by `kind`** (a const map / derived boolean), *not* a method on the parsed config and *not* a free `checkpoint(refs)` — promote to a richer capability only if a vendor later needs custom granularity (§7 Q3).
3. **Atomic-cursor mapping is real work, not "unchanged."** The orchestrator (`execute-integration.use-case.ts:148-219`) advances `latestCursor = change.cursor` per yield and persists last-yielded on iterator failure (`:192-208`) — which makes per-ref checkpointing *free for divisible cursors*. But for **atomic** cursors that same persist-last-yielded behavior is the silent-tail bug: a mid-walk opaque token would be persisted and is non-resumable. So R2 must make the base **withhold `change.cursor` until a safe boundary** for atomic strategies — emit the new token only at end-of-window/end-of-walk, so the orchestrator never persists an unresumable mid-walk token. The orchestrator's persist-on-success lifecycle is reused unchanged; the *base* owns the `Ref.cursor → Change.cursor` gating.

## 4. What codegen emits (the scaffold reshape)

`generateAdapterScaffold` (`src/cli/shared/adapter-emission-generator.ts:227`) changes its read-side body. Today it emits one class with an empty `changeSources = {}` (`:311`). After this RFC, per entity in `capabilities.entities` it emits an **emit-once `IncrementalReadBase` subclass** and registers it:

```ts
// <CODEGEN-SCAFFOLD-V1>   ← still emit-once; regen skips if present
// fork #2: the entity's `detection.filters` emitted verbatim as a static const.
const EMAIL_DETECTION_FILTERS: ResolvedFilter[] = [ /* from entity `detection:` YAML */ ];

export class GoogleEmailIncrementalRead
  extends IncrementalReadBase<CanonicalEmail, ResolvedFilter[]> {   // F = uniform runtime filter; M defaults (author narrows)
  readonly label = 'google-mail-email';
  // Codegen emits `false` (the safe post-hydrate floor); the AUTHOR flips it to
  // `true` once their `enumerate` pushes the filter to the vendor (Gmail `q=`).
  protected override readonly filterPushdown = false;
  // When the entity's cursor strategy is atomic (Gmail historyId / Calendar
  // syncToken), codegen ALSO emits `protected override readonly cursorDivisible = false;` (R2).

  constructor(
    private readonly auth: IAuthStrategy,
    private readonly client: GoogleClient,
  ) { super(); }

  protected async *enumerate(mode: ReadMode, filter?: ResolvedFilter[], pageSize?: number): AsyncIterable<Ref[]> { /* TODO: messages.list / history.list → Ref pages */ }
  protected async hydrate(ids: string[]): Promise<Map<string, unknown>> { /* TODO: messages.get (override: /batch) → Map<id, raw> */ }
  protected toCanonical(raw: unknown): CanonicalEmail | null { /* TODO: External(Zod) → CanonicalEmail */ }

  // fork #2: filterFor returns the static const — 2-arg `(auth, client)` construction preserved.
  protected override filterFor(_sub: IntegrationSubscriptionView): ResolvedFilter[] {
    return EMAIL_DETECTION_FILTERS;
  }
}
```

> **R3 typing + threading — RESOLVED (2026-05-31, Doug).** Two R3-build forks (separate from §7's Q1/Q3/Q4) are now locked:
>
> **Fork #1 — subclass typing (Option B).** Emit `IncrementalReadBase<CanonicalEmail, ResolvedFilter[]>`: **T** = the surface package's canonical type; **F** = the *existing uniform* `ResolvedFilter[]` (from `DetectionConfig.filters`) — not a bespoke per-entity `EmailFilter`; **M** = the base default (`Record<string, unknown>`), which the author narrows in the emit-once scaffold (it's the vendor list-stub shape — author knowledge). This gives free compile-time filter typing with zero new types and no surface-package coupling. The earlier `<…, EmailFilter, EmailRefMeta>` bespoke shape is **superseded** — codegen-owned bespoke F/M types roll up into RFC-0004 ("B", the canonical-model RFC), not R3.
>
> **Fork #2 — filter threading (static const).** `IntegrationSubscriptionView` is only `{ id, domain, externalRef }` — it does NOT carry filters. So codegen emits the entity's `detection.filters` as a static module-level `ResolvedFilter[]` const and `filterFor()` returns it. This preserves the post-E0 2-arg `(auth, client)` construction (no DI of a never-changing value). Dynamic stays open two ways: a direct `read(ReadRequest<F>)` caller passes runtime filters, and an author can override `filterFor(sub)` (emit-once) to derive per-subscription.
>
> **Named caveat:** this assumes filters are **entity-level config, not per-subscription**. If two subscriptions of one entity ever need different filters, revisit via the `filterFor(sub)` author override — keep the `subscription` param in the emitted signature so that escape hatch stays free.

and the adapter's container becomes — assigned in the **constructor body**, not as a
field initializer (under `useDefineForClassFields`, field initializers run *before*
constructor parameter-property assignment, so `this.auth`/`this.client` would be
`undefined` at field-init time):

```ts
readonly changeSources: Record<string, IChangeSource<unknown>>;   // declared; assigned in ctor

constructor(
  @Inject(GOOGLE_AUTH_STRATEGY) readonly auth: IAuthStrategy,
  @Inject(GOOGLE_CLIENT) private readonly client: GoogleClient,
) {
  this.changeSources = {
    email: new GoogleEmailIncrementalRead(this.auth, this.client),   // single construction site (composes RFC-0002 §3 Option A)
  };
}
```

Unchanged: the emit-once sentinel + skip-on-regen, the `@Injectable` adapter `implements <Port>`, the `capabilities` literal, and the constructor injection.

> **E0 is a hard prerequisite for R3 — not yet landed on `main`.** The 2-arg `new GoogleEmailIncrementalRead(this.auth, this.client)` construction site above assumes the **post-E0** scaffold (no `IEntityChangeSourceRegistry` injection). As of this RFC's branch the scaffold *still* imports the registry (`adapter-emission-generator.ts:285`) and injects it (`:301` `@Inject(${entitySourcesToken}) readonly sources`); commit `6e77e49` ("E0 — drop registry back-edge") lives only on `feat/td-r2-e0/e1/e2`, **not** on `main`. **R3 must not start until E0 has merged to the R3 branch base** (either rebase onto the E-track, or fold the registry-drop into R3). R1/R2 are pure runtime additions and have no E0 dependency.

The `filterPushdown` flag must flow into a **net-new adapter-emission manifest** (no such manifest pipeline exists today) so the falsifier suite (also net-new, §8) can assert *"emits only records matching the filter"* and record which adapters filter post-hydrate. Building the manifest field is R3 work; building the falsifier harness is R4 work.

**Filter source:** `DetectionConfig.filters` (already parsed → `ResolvedFilter[]`, already handed to the poll callback as `ctx.filters`) maps to `ReadRequest.filter`. The discipline this RFC adds is *where* it's applied (pre-hydrate) and *whether the vendor pushed it down* (the flag) — the hook already exists.

## 5. Modes, not methods (anti-pattern guard)

`backfillAll` and `backfillMissing` are **not** new verbs (swe-brain ADR-0003: mode ≠ capability). They are `ReadMode` values: `full` (cursorless), `delta` (cursored), and the new `reconcile` (gap-repair — re-fetch a known id set the cursor skipped). `reconcile` is the repair pass for the silent-tail-skip and for #414-style multi-provider divergence later. One `read()` verb; three modes.

## 6. Relationship to RFC-0002 — disjoint, composes, no collision

> _Cross-branch note:_ RFC-0002 is **not a file on this branch** (`docs/rfcs/` here holds only RFC-0001 and RFC-0003); the quoted passages below are reproduced from the E-track and are unverifiable from this branch. Confirm them against RFC-0002 once the branches converge.

RFC-0002 declares the read-side body **out of its own scope** twice: §1 *"Unchanged author-seam: the `IChangeSource.listChanges` fetch body inside the adapter scaffold's `changeSources`"*; §6 *"adapter scaffold `changeSources` (author fills the `IChangeSource` bodies) — Kept."* RFC-0002 builds the **assembly** (sink, per-entity `ExecuteIntegrationUseCase`, module packaging, aggregator, tokens) *around* `adapter.changeSources['<entity>']`, consuming it as an opaque `IChangeSource`. This RFC reshapes **what's inside** that seam.

- **Different altitudes of the same emitter.** RFC-0002 wires the box; RFC-0003 shapes the box's contents. The assembly binds `INTEGRATION_CHANGE_SOURCE = adapter.changeSources['<entity>']` regardless of how the body is authored.
- **Shared file de-conflicted via E0 — which must land first.** Both touch `generateAdapterScaffold`. RFC-0002's only change there is **E0** (drop the `IEntityChangeSourceRegistry` injection), committed on the E-track as `6e77e49` but **not yet merged to `main`** (see §4 prerequisite callout). RFC-0003's R3 builds on the post-E0 scaffold; E1–E4 add new files and don't re-touch the body. **Sequencing constraint:** R3 is gated on E0 reaching R3's branch base. R1/R2 are independent.
- **RFC-0003 reinforces RFC-0002 §3.** §3 resolved to Option A ("source built once, single construction site"). With the body an `IncrementalReadBase` subclass, the `changeSources['<entity>']` entry *is* the single construction — Option A becomes true at the type level.
- **"Migrate once" binds the release.** Both reshape the shape swe-brain migrates against. Ship **both in the 0.13 train** (RFC-0002 assembly + RFC-0003 read body) so swe-brain regenerates and fills bodies exactly once. swe-brain may prototype the three hook bodies now (they move verbatim), but consumption waits for the combined 0.13 shape.

## 7. Open questions — for Doug

1. **Capability home.** ✅ **RESOLVED (R1) — subsystems.** `IncrementalRead`/`RandomRead`/`IncrementalReadBase` landed in `runtime/subsystems/integration/incremental-read.ts`, exported from `@pattern-stack/codegen/subsystems` (beside `IChangeSource`). It's runtime, vendor-agnostic, and produces an `IChangeSource` — the surface-package framework would have inverted the dependency.
2. **`enumerate` ref granularity.** Minimal (`{externalId, cursor}` only) vs **rich** (`Ref<M>` with metadata) — *recommended rich*, since pre-hydrate filtering and a future "query-surface lists cheaply, fills on click" both need metadata. Cost: a domain `M` type per surface (lives in the consumer / surface package).
3. **Cursor-divisibility surface (§3).** ✅ **RESOLVED (R2) — flag, kind-keyed.** Shipped as `CURSOR_DIVISIBILITY` (a `Record<kind, boolean>`) + `isDivisibleCursor(kind)` beside `CursorStrategy`, plus a `cursorDivisible` boolean on `IncrementalReadBase`. Not a `checkpoint(refs)` method — `CursorStrategy` is a parsed Zod config object, so behavior cannot live on it. Promote to a method only if a vendor needs custom checkpoint granularity.
4. **`reconcile` mode scope.** ✅ **RESOLVED (R1) — enum + contract landed; driver deferred.** `ReadMode = delta | full | reconcile` and `enumerate(mode='reconcile', …)` are in the base now (cheap). A scheduled reconcile runner remains a separate consumer concern.

## 8. Snapshot + tests

Extend the RFC-0001 §7 / RFC-0002 §8 integration-emission snapshot fixture (`test/fixtures/integration-patterns/`) to assert the reshaped read-side scaffold (per-entity `IncrementalReadBase` subclass + `changeSources` registration). Add a **falsifier** assertion keyed off `filterPushdown`: a conforming adapter emits only records matching the request filter, regardless of pushdown. Per the standing rule (memory `project_baseline_clean_arch_only`): template-emission tests, not baseline.

## Sequencing (post-RFC, after Gate 1.5)

- **R1** — ✅ **DONE.** Landed `IncrementalRead`/`RandomRead`/`IncrementalReadBase` + `SourcedRecord`/`Ref`/`ReadMode`/`ReadRequest` + `mapConcurrent` in `runtime/subsystems/integration/incremental-read.ts`; exported from `@pattern-stack/codegen/subsystems`. Unit-tested the base (drain, pre-hydrate filter, keyed/miss-tolerant hydrate, free `get` over hydrate, per-ref cursor, `listChanges` adaptation, `mapConcurrent` bounds — 21 cases). Pure runtime addition, no emitter change. Parallel to RFC-0002 E1–E4.
- **R2** — ✅ **DONE.** Cursor-strategy divisibility (§3): added atomic `historyId`/`syncToken` kinds + `CURSOR_DIVISIBILITY` map + `isDivisibleCursor`; `IncrementalReadBase.cursorDivisible` gates `listChanges` cursor emission (atomic ⇒ withhold per-ref, emit end-of-walk token only on the final record via one-record lookahead). Orchestrator unchanged — its skip-null-cursor + persist-last-yielded lifecycle does the rest. Atomic-backfill blast-radius (= enumerate walk) documented; `ReadRequest.pageSize` is the bound.
- **R3** — ✅ **DONE** (stacked on the E-track). Reshaped `generateAdapterScaffold` read-side body (`src/cli/shared/adapter-emission-generator.ts`): per-entity `IncrementalReadBase<Canonical<Entity>, ResolvedFilter[]>` subclass + `changeSources` registration (constructor-body assignment — `useDefineForClassFields` safety). Implementation decisions:
  - **Scope = interaction surfaces only.** Gated by a new `SurfaceSpec.readPrimitive` flag (mail/calendar/transcript). CRM keeps its empty author-filled `changeSources` seam — it has no single canonical `T` (field-reader model).
  - **Canonical type by convention:** `Canonical${Pascal(entity)}`, imported from the surface package (verified: `email→CanonicalEmail`, `meeting→CanonicalMeeting`, `transcript→CanonicalTranscript`).
  - **Detection threading:** `generateAdapterScaffold` gains a `entityDetection?: Map<string, DetectionConfig>` param (caller resolves `entity.detection[providerSlug]`). Drives the static `<ENTITY>_DETECTION_FILTERS` const (fork #2) and `cursorDivisible` (R2: emitted `false` only when the cursor kind is atomic).
  - **`filterPushdown`:** emitted `false` + author-flip comment. **The net-new manifest field is deferred to R4** — `filterPushdown` is author-owned (emit-once code), so a YAML-derived manifest can't see the author's value; that tension is R4's to resolve (likely promote `filterPushdown` to a `detection:` YAML field).
  - **Barrel fix:** `ResolvedFilter` + `IntegrationSubscriptionView` are now re-exported from the top `@pattern-stack/codegen/subsystems` barrel (the emitted scaffold imports them; caught by compiling a real emitted adapter against the live types).
  - Snapshot rebaselined (template-emission, per §8 — *not* `just test-baseline`); unit tests cover the reshape + atomic/divisible cursor wiring + CRM-unchanged.

  > **Discovered (out of R3 scope) — interaction ports require `sources` the post-E0 scaffold no longer provides.** `MailPort`/`CalendarPort`/`TranscriptPort` declare `readonly sources: IEntityChangeSourceRegistry`, but **E0** dropped that injection from the adapter (it now exposes `changeSources`, folded into the registry by the aggregator). So a generated interaction adapter does **not** satisfy its port (`TS2420: Property 'sources' is missing`). This predates RFC-0003 and is invisible to the string-based emission tests + the smoke suite (which doesn't compile interaction surfaces). **Fix belongs in Track C / the E-track:** drop `sources` from the interaction port contracts (the registry is the surface module's concern, not the adapter's), or re-introduce it. Tracked separately.
- **R4** — *(pending)* falsifier assertion (§8, keyed off `filterPushdown`) + the `filterPushdown` manifest decision + docs (integration skill `protocols-and-ports.md`: the enumerate/hydrate authoring recipe, HubSpot `listSince` as the north star).
- **Release** — ship R1–R4 in **0.13 alongside RFC-0002 E1–E4** (one consumer-facing shape).

## Deliverable

After 0.13: codegen emits an integration that is correct-by-construction on the read path — streaming, bounded-parallel hydration, filter-before-hydrate, per-ref checkpointing where the cursor allows — and the author fills exactly three vendor methods (`enumerate` / `hydrate` / `toCanonical`) plus any non-generic sink write logic. The buffer-all/serial/run-final-cursor regression becomes structurally unwritable. swe-brain consumes it in one regen (RFC-0002 assembly + RFC-0003 read body together), deleting the hand-rolled `pullX` ports and `*_integration` modules.

## Spec Review (Gate 1.5 critique)
<!-- written by: reviewer · gate 1.5 · /sdlc:critique · lens=mixed · rerun (rev 2) -->

**Target:** `docs/rfcs/RFC-0003-incremental-read-enumerate-hydrate.md` (rev 2)
**Against:** cited-code (`src/cli/shared/adapter-emission-generator.ts`, `runtime/subsystems/integration/*`; swe-brain/dealbrain reference adapters NOT readable on this branch)
**Verdict:** PASS_WITH_NOTES

_Re-critique of rev 2. Both rev-1 blockers cleared — verified, not merely reworded:_
- **Blocker 1 (E0 framing) — CLEARED.** §4 now carries an explicit hard-prerequisite blockquote ("E0 ... not yet landed on `main`"), correctly citing the still-present registry import (`adapter-emission-generator.ts:285`, verified) and injection (`:301 @Inject(...entitySourcesToken) readonly sources`, verified present). §6's "Shared file de-conflicted via E0 — which must land first" bullet and the R3 "(gated on E0 landing)" prefix gate R3 correctly; R1/R2 framed E0-independent. The `6e77e49` claim is accurate: it is NOT on `main` and lives on `feat/td-r2-e0/e1/e2` (confirmed via `git branch --contains`).
- **Blocker 2 (citation drift) — CLEARED.** All seam references now read `src/cli/shared/adapter-emission-generator.ts`; seam at `:311` (verified exact) and `generateAdapterScaffold` at `:227` (verified exact). No remaining `:308` or `src/integration/...` references.

_All rev-1 notes also addressed substantively:_ `SourcedRecord<T>` is now formally defined (§1, lines 60-69) with a doc-comment reconciling it one-directionally against `Change<T>` (raw dropped on the `listChanges` adaptation) and a "net-new in R1" line; §3 rewritten to name `CursorStrategy` a Zod union, flag `historyId`/`syncToken` as net-new kinds, scope divisibility as a kind-keyed predicate (not a method), and specify the atomic-cursor token-withholding gating against the verified `execute-integration.use-case.ts:148-219` / `:192-208` persist-last-yielded behavior; the manifest is re-scoped net-new in §4 (R3 field, R4 harness). Both rev-1 nits got their external/cross-branch markers and the R3 snapshot vocabulary is aligned to "template-emission snapshot, not `just test-baseline`."

**Blockers (0):** none. Gate 1.5 cleared — R1 (E0-independent) may proceed.

**Notes (2):**
- [§3.3] The atomic-cursor gating ("base withholds `change.cursor` until a safe boundary") is the right shape, but note for R2: with no per-ref token emitted mid-walk, an interrupted atomic *backfill* (full/reconcile) resumes from the **last completed window**, not the last record — so the window size is now the data-reprocessing blast radius on resume. R2 should make the enumerate window/page size explicit (and idempotent re-delivery via the existing dedup/fingerprint path covers the re-processed overlap). Not blocking — the design is correct; this is a parameter to surface, not a defect.
- [§1 / §7 Q1] §7 Q1 (capability home: subsystems vs surface-package) is still genuinely open, but §1 already asserts placement in `runtime/subsystems/integration/` as fact and R1 lands it there. The recommendation and the body have effectively pre-decided Q1. Fine to proceed on the recommendation, but either close Q1 or soften §1's "Lives in ..." to "Lands in ... (pending Q1)" so the open-question list stays honest.

**Nits (1):**
- [Status line] Header still reads "Draft — Gate 1.5 critique addressed (rev 2); pending re-critique." On merge, flip to "Accepted (Gate 1.5: PASS_WITH_NOTES)" so the doc state matches the verdict.

**Reviewed by:** reviewer agent · 2026-05-31T00:00:00Z (rev 2)
