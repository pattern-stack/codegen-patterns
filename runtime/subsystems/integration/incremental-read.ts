/**
 * Integration subsystem — `IncrementalRead<T, F>` + `RandomRead<T>` capability
 * and the providing `IncrementalReadBase<T, F, M>` (RFC-0003 R1).
 *
 * The universal read primitive. Where `IChangeSource.listChanges` is the
 * *transport* contract (stream `Change<T>`, orchestrator owns cursor lifecycle),
 * this base owns *how the body that produces those changes is written* — the
 * level the bare `changeSources = {}` author-seam left unstructured.
 *
 * The read decomposes into two composable verbs the adapter supplies:
 *
 *   - `enumerate(mode, filter) → AsyncIterable<Ref<M>[]>` — the cheap delta /
 *     backfill walk; streams pages of lightweight refs (id + per-ref cursor +
 *     filterable metadata). LAZY: pull-driven so hydrate backpressures it.
 *   - `hydrate(ids) → Map<id, raw>` — the expensive fetch-by-id, batched; where
 *     bounded concurrency / a vendor `/batch` endpoint lives. Keyed and
 *     miss-tolerant (a mid-run 404 cannot shift alignment).
 *   - `toCanonical(raw) → T | null` — provider payload → canonical record.
 *
 * The base PROVIDES the orchestration: drain enumerate, **filter before
 * hydrate** (structural — an adapter physically cannot hydrate-then-discard),
 * keyed pairing, per-ref cursor emission, and the `IChangeSource.listChanges`
 * adaptation. It also provides `RandomRead.get()` for free as
 * `toCanonical ∘ hydrate([id])` — so every incremental adapter is a
 * single-record reader (the "list cheaply, fill on click" query-surface need)
 * without extra code.
 *
 * The shape generalizes dealbrain's proven HubSpot `listSince` (streams, pushes
 * the filter server-side, carries a per-record cursor) to vendors whose list
 * returns id-stubs (Gmail) or nested resources (Meet). Calendar-style
 * full-object lists override `hydrate` as a passthrough.
 *
 * See RFC-0003 (Track D round-3), ADR-033 (`detection:` config), and
 * `poll-change-source.ts` (the sibling primitive this composes beside).
 */

import type {
  Change,
  ChangeSource,
  IChangeSource,
  IntegrationSubscriptionView,
} from './integration-change-source.protocol';

// ============================================================================
// Capability shapes
// ============================================================================

/**
 * How a read walks the upstream. Modes are values, not verbs (swe-brain
 * ADR-0003: mode ≠ capability) — one `read()` verb dispatches on these.
 *
 *   - `delta`     — incremental walk from a persisted cursor.
 *   - `full`      — cursorless backfill (optionally bounded by `since`).
 *   - `reconcile` — gap-repair: re-fetch a known id set the cursor skipped
 *                   (the repair pass for the silent-tail-skip + #414-style
 *                   multi-provider divergence).
 */
export type ReadMode =
  | { readonly kind: 'delta'; readonly cursor: unknown }
  | { readonly kind: 'full'; readonly since?: Date }
  | { readonly kind: 'reconcile'; readonly knownIds: readonly string[] };

/**
 * A cheap ref from the enumerate pass: identity + per-ref cursor + metadata to
 * filter or display on. `cursor` is the position AS OF this ref — see
 * `IncrementalReadBase.cursorDivisible` (R2) for when it may be checkpointed
 * mid-walk versus withheld until a safe boundary.
 */
export interface Ref<M = Record<string, unknown>> {
  readonly externalId: string;
  readonly cursor: unknown;
  readonly meta: M;
}

/** A read request: the mode, an optional adapter-typed filter, and page size. */
export interface ReadRequest<F = unknown> {
  readonly mode: ReadMode;
  readonly filter?: F;
  readonly pageSize?: number;
}

/**
 * Per-run context threaded from `listChanges` into the vendor read body (R5).
 *
 * Carries the `subscription` framing the run so `enumerate`/`hydrate` can resolve
 * **per-connection credentials** (and raw-landing keys) from
 * `subscription.externalRef` — the gap a multi-account consumer surfaced: a
 * singleton change source cannot hold connection-scoped auth, and before R5 the
 * base forwarded the subscription only into `filterFor`, never into the fetch.
 *
 * Optional throughout (the core contract): a direct `read()` / `get()` call — the
 * query surface's "fill one record on click" — may omit it. An adapter that needs
 * per-connection auth reads `ctx?.subscription?.externalRef` and asserts its
 * presence; a provider-level-auth adapter ignores it.
 */
export interface ReadContext {
  /** The subscription framing this run; `externalRef` is the upstream scope /
   *  connection id the adapter resolves credentials + raw-landing keys from. */
  readonly subscription?: IntegrationSubscriptionView;
}

/**
 * The `read()`-side envelope: canonical record + the raw vendor payload it came
 * from + the originating external id + the per-ref cursor.
 *
 * Distinct from the runtime's transport envelope `Change<T>`
 * (operation/externalId/cursor/source). The relationship is one-directional:
 * `listChanges()` adapts `read()` → `Change<T>` (dropping `raw`, stamping
 * `operation`). `read()` keeps `raw` and `externalId` so a query surface can
 * re-project without a second fetch.
 */
export interface SourcedRecord<T> {
  readonly externalId: string;
  readonly record: T;
  readonly raw: unknown;
  readonly cursor: unknown;
}

/**
 * The universal read capability — one public verb that streams. Filtering,
 * hydration, and cursor emission are the providing base's concern.
 */
export interface IncrementalRead<T, F = unknown> {
  read(req: ReadRequest<F>, ctx?: ReadContext): AsyncIterable<SourcedRecord<T>>;
}

/**
 * Single-record read by external id — the "fill on click" atom. Provided for
 * free by `IncrementalReadBase` (composes `hydrate` + `toCanonical`); declared
 * as its own capability so consumers can depend on it without the streaming
 * surface.
 */
export interface RandomRead<T> {
  get(id: string, ctx?: ReadContext): Promise<T | null>;
}

// ============================================================================
// Bounded-parallel map helper
// ============================================================================

/**
 * Map `ids` through `fn` with at most `limit` concurrent in-flight calls,
 * collecting results keyed by id. The workhorse for writing a batched
 * `hydrate` over a single-id fetch without serial N+1 latency.
 */
export async function mapConcurrent<R>(
  ids: readonly string[],
  fn: (id: string) => Promise<R>,
  limit: number,
): Promise<Map<string, R>> {
  const out = new Map<string, R>();
  if (ids.length === 0) return out;
  const width = Math.max(1, Math.min(limit, ids.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const idx = next++;
      const id = ids[idx]!;
      out.set(id, await fn(id));
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// ============================================================================
// IncrementalReadBase
// ============================================================================

/**
 * Providing base for the read capability. A subclass fills exactly three vendor
 * methods — `enumerate`, `hydrate`, `toCanonical` — and gets a streaming,
 * filter-before-hydrate, miss-tolerant `IncrementalRead<T, F>` +
 * `IChangeSource<T>` + `RandomRead<T>`.
 *
 * Type params: `T` canonical record, `F` adapter-typed filter, `M` per-ref
 * metadata (defaults to an untyped bag — surface packages supply a domain `M`).
 */
export abstract class IncrementalReadBase<T, F = unknown, M = Record<string, unknown>>
  implements IncrementalRead<T, F>, IChangeSource<T>, RandomRead<T>
{
  /** Human label for run logs — e.g. `'google-mail-email'`. */
  abstract readonly label: string;

  /**
   * Whether the vendor takes the request predicate server-side. Declared, not
   * enforced here — surfaced into the emission manifest (R3) so the falsifier
   * suite (R4) can record which adapters filter post-hydrate. `false` is the
   * honest floor (e.g. Gmail without `q=`), handled via `matchesRecord`.
   */
  protected readonly filterPushdown: boolean = false;

  /** Max concurrent in-flight calls for a `mapConcurrent`-built `hydrate`. */
  protected readonly hydrateConcurrency: number = 10;

  /** `Change<T>.source` provenance stamped by `listChanges`. */
  protected readonly changeSource: ChangeSource = 'poll';

  /**
   * Whether this source's cursor strategy is divisible (RFC-0003 §3). When
   * `true` (default — sortable watermarks like `systemModstamp`/`timestamp`/
   * `replayId`), `listChanges` emits each record's per-ref cursor, so the
   * orchestrator may checkpoint mid-walk and a crash resumes from the last
   * delivered ref.
   *
   * When `false` (atomic opaque tokens — Gmail `historyId`, Calendar
   * `syncToken`), `listChanges` WITHHOLDS per-ref cursors and emits the
   * end-of-walk token only on the final record, so the orchestrator's
   * persist-last-yielded lifecycle can never persist an unresumable mid-walk
   * token. The cost is blast-radius: an interrupted atomic run resumes
   * all-or-nothing from the prior persisted token. For atomic *backfills* that
   * radius is the whole enumerate walk — bound it with `ReadRequest.pageSize`
   * (smaller pages ⇒ shorter walks per run). Per-page atomic checkpointing is a
   * future refinement; R2 gates at end-of-walk.
   *
   * Codegen (R3) sets this from the strategy kind via `isDivisibleCursor`.
   */
  protected readonly cursorDivisible: boolean = true;

  // ---- SUPPLIED by the adapter (the irreducible vendor seam) ----

  /**
   * The cheap walk. Streams pages of refs; LAZY so `hydrate` backpressures it
   * (one page hydrated before the next is pulled). Mode-dispatch lives here:
   * `delta` resumes from `mode.cursor`, `full` walks from the top, `reconcile`
   * re-fetches `mode.knownIds`.
   *
   * `pageSize` (from `ReadRequest`) is the adapter's requested vendor page size
   * — also the atomic-cursor backfill blast-radius bound (§ `cursorDivisible`).
   * Honor it as a hint; vendors that cap page size clamp it.
   *
   * `ctx?.subscription` (R5) carries the run's subscription, so a per-connection
   * adapter resolves credentials / upstream scope from `externalRef` here; absent
   * on a direct `read()` with no run subscription.
   */
  protected abstract enumerate(
    mode: ReadMode,
    filter?: F,
    pageSize?: number,
    ctx?: ReadContext,
  ): AsyncIterable<Ref<M>[]>;

  /**
   * Fetch raw payloads for `ids`, keyed by id. MUST be miss-tolerant: omit (or
   * map to `null`) any id that 404s mid-run rather than throwing or shifting
   * alignment. Write it over `mapConcurrent(ids, (id) => this.fetchOne(id),
   * this.hydrateConcurrency)`; override with a real `/batch` call or a
   * passthrough (full-object list) where the vendor allows.
   *
   * `ctx?.subscription` (R5) carries the run's subscription for per-connection
   * credential resolution (the fetch is where the vendor call happens) and is the
   * natural place to land raw payloads keyed by `subscription.id`.
   */
  protected abstract hydrate(ids: string[], ctx?: ReadContext): Promise<Map<string, unknown>>;

  /** Provider payload → canonical record. Return `null` to drop a record. */
  protected abstract toCanonical(raw: unknown): T | null;

  // ---- Optional filter hooks — exactly one is live per `filterPushdown` ----

  /** Pre-hydrate predicate over the cheap ref (preferred — avoids hydration). */
  protected matchesRef(_ref: Ref<M>, _filter?: F): boolean {
    return true;
  }

  /** Post-hydrate predicate over the canonical record (the no-pushdown floor). */
  protected matchesRecord(_record: T, _filter?: F): boolean {
    return true;
  }

  /**
   * Resolve the filter for a subscription when adapting to `listChanges`
   * (which has no filter argument). Defaults to none; codegen wiring (R3)
   * overrides this to thread `DetectionConfig.filters`.
   */
  protected filterFor(_subscription: IntegrationSubscriptionView): F | undefined {
    return undefined;
  }

  // ---- PROVIDED by the base ----

  /**
   * Stream canonical records for a request. Filter is applied BEFORE hydrate
   * (structural: a kept ref is hydrated, a rejected one never is), so an
   * adapter cannot hydrate-then-discard. A hydrate miss (deleted mid-run) is
   * skipped, never fabricated.
   */
  async *read(req: ReadRequest<F>, ctx?: ReadContext): AsyncIterable<SourcedRecord<T>> {
    for await (const refPage of this.enumerate(req.mode, req.filter, req.pageSize, ctx)) {
      const kept = refPage.filter((ref) => this.matchesRef(ref, req.filter));
      if (kept.length === 0) continue;
      const raws = await this.hydrate(
        kept.map((ref) => ref.externalId),
        ctx,
      );
      for (const ref of kept) {
        const raw = raws.get(ref.externalId);
        if (raw === undefined || raw === null) continue; // deleted mid-run → skip
        const record = this.toCanonical(raw);
        if (record !== null && this.matchesRecord(record, req.filter)) {
          yield { externalId: ref.externalId, record, raw, cursor: ref.cursor };
        }
      }
    }
  }

  /**
   * `RandomRead<T>` — single-record read, provided for free as
   * `toCanonical ∘ hydrate([id])`. Reuses the adapter's batched fetch + miss
   * tolerance; returns `null` for a missing or undecodable record.
   */
  async get(id: string, ctx?: ReadContext): Promise<T | null> {
    const raws = await this.hydrate([id], ctx);
    const raw = raws.get(id);
    if (raw === undefined || raw === null) return null;
    return this.toCanonical(raw);
  }

  /**
   * `IChangeSource<T>` adaptation. Maps the orchestrator's by-value cursor to a
   * `ReadMode` (`null` → `full` backfill, else `delta`), streams `read()`, and
   * stamps each `SourcedRecord` into a `Change<T>`. All records surface as
   * `'updated'`; the orchestrator's diff stage classifies create-vs-update and
   * deletes arrive as tombstone refs (`toCanonical` may flag them).
   *
   * Cursor emission honors `cursorDivisible` (RFC-0003 §3). Divisible: each
   * record carries its own per-ref cursor. Atomic: per-ref cursors are withheld
   * (`undefined`, which the orchestrator skips persisting) and the end-of-walk
   * token rides only on the final record — so a mid-walk crash never persists
   * an unresumable token. If an atomic run yields no surviving records, no
   * cursor is persisted and the next run re-reads the same (empty) delta — a
   * bounded inefficiency, never data loss.
   */
  async *listChanges(
    subscription: IntegrationSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>> {
    const mode: ReadMode =
      cursor === null || cursor === undefined
        ? { kind: 'full' }
        : { kind: 'delta', cursor };
    const filter = this.filterFor(subscription);
    // R5: thread the run's subscription into the read body so `enumerate`/`hydrate`
    // can resolve per-connection credentials (and raw-landing keys) from it.
    const stream = this.read({ mode, filter }, { subscription });

    if (this.cursorDivisible) {
      for await (const sourced of stream) {
        yield this.toChange(sourced, sourced.cursor);
      }
      return;
    }

    // Atomic: one-record lookahead. Emit every record but the last with a
    // withheld (`undefined`) cursor; the last record carries the end-of-walk
    // token. Contract: an atomic adapter stamps the (single, shared) end-of-walk
    // token onto its refs' `cursor` — so whichever record survives last carries
    // it. The base emits a real cursor exactly once, on that final record, so the
    // orchestrator can never persist a mid-walk value. If zero records survive,
    // nothing is persisted (next run re-reads the delta — bounded, never lossy).
    let prev: SourcedRecord<T> | null = null;
    for await (const sourced of stream) {
      if (prev !== null) yield this.toChange(prev, undefined);
      prev = sourced;
    }
    if (prev !== null) yield this.toChange(prev, prev.cursor);
  }

  /** Stamp a `SourcedRecord` into a `Change<T>` with an explicit emitted cursor. */
  private toChange(sourced: SourcedRecord<T>, cursor: unknown): Change<T> {
    return {
      externalId: sourced.externalId,
      operation: 'updated',
      record: sourced.record,
      cursor,
      source: this.changeSource,
    };
  }
}
