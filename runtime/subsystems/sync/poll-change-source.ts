/**
 * Sync subsystem — `PollChangeSource<T>` primitive (#226-3, ADR-033).
 *
 * Generic poll-mode `IChangeSource<T>` implementation parameterized by a
 * parsed `DetectionConfig` (poll mode) and a consumer-supplied
 * `PollFetchCallback<T>`. The primitive owns:
 *
 *   - filter resolution (flat-AND vocabulary per epic decision Q3 — richer
 *     boolean expressions deferred);
 *   - field mapping → `Change.externalId` derivation;
 *   - cursor strategy passthrough (the orchestrator passes the prior cursor
 *     by-value per ADR-033 / #226-2; the callback yields the next cursor
 *     per record; the primitive simply stamps it onto `Change<T>`);
 *   - `Change<T>.source` provenance (`'poll'` by default);
 *   - middleware-chain composition (the `ChangeMiddleware<T>` shape
 *     locked in #226-1).
 *
 * Shape locks (decision memo Q5):
 *   - `PollFetchContext = { subscription, cursor, filters }` — explicitly
 *     NO `userId` / `tenantId`. Run-scope identity is closed over by the
 *     consumer at adapter construction (or resolved inside the callback
 *     via consumer services). Threading it through the seam would force
 *     port expansion every time run-context grows.
 *
 * The adapter callback returns `{ record: T; cursor: PollCursor }` — the
 * primitive does not reach into the record to extract a cursor itself.
 * `cursor.field` from `DetectionConfig.poll.cursor` is metadata for codegen
 * + adapters; the primitive trusts what the callback yielded.
 */

import type {
  DetectionConfig,
  ResolvedFilter,
} from './detection-config.schema';
import type {
  Change,
  ChangeSource,
  IChangeSource,
  SyncSubscriptionView,
} from './sync-change-source.protocol';
import type {
  ChangeIterator,
  ChangeMiddleware,
} from './sync-middleware.protocol';

// ============================================================================
// Cursor + adapter callback shapes
// ============================================================================

/**
 * Opaque poll-cursor shape. Each provider/entity pair binds it concretely
 * via the cursor strategy (`{ systemModstamp }`, `{ replayId }`, etc.); the
 * primitive treats it as an opaque value to pass through.
 */
export type PollCursor = unknown;

/**
 * The context the primitive forwards to the adapter callback. Locked to
 * exactly three fields per decision memo Q5 — `userId` / `tenantId` are
 * NOT here on purpose.
 */
export interface PollFetchContext {
  readonly subscription: SyncSubscriptionView;
  readonly cursor: PollCursor | null;
  readonly filters: readonly ResolvedFilter[];
}

/**
 * Consumer-supplied fetch callback. Returns an async iterable of
 * `{ record, cursor }` pairs — `record` is already the canonical `T`
 * (the adapter does provider-side translation), `cursor` is the post-record
 * cursor the orchestrator should persist if the run completes successfully.
 */
export type PollFetchCallback<T> = (
  ctx: PollFetchContext,
) => AsyncIterable<{ record: T; cursor: PollCursor }>;

// ============================================================================
// Constructor options
// ============================================================================

export interface PollChangeSourceOptions<T> {
  /** Consumer-supplied fetch callback. */
  readonly adapter: PollFetchCallback<T>;
  /**
   * Parsed detection config. MUST be `mode: 'poll'`; the constructor
   * throws if a webhook config is supplied. Codegen-emitted factories
   * call `DetectionConfigSchema.parse(...)` upstream so this is a safety
   * net, not the primary validation point.
   */
  readonly config: DetectionConfig;
  /**
   * Optional middleware chain. First element is the outermost layer:
   * sees `(subscription, cursor)` first and yielded `Change<T>` last.
   * Locked shape (#226-1) — the primitive composes them with its own
   * `listChanges` implementation as the innermost iterator.
   */
  readonly middlewares?: ReadonlyArray<ChangeMiddleware<T>>;
  /**
   * Optional human label for run logs (e.g. `'salesforce-poll-opportunity'`).
   * Defaults to a derived label based on the subscription domain at
   * construction time fallback — adapters are encouraged to provide one.
   */
  readonly label?: string;
}

// ============================================================================
// PollChangeSource<T>
// ============================================================================

export class PollChangeSource<T> implements IChangeSource<T> {
  public readonly label: string;

  private readonly adapter: PollFetchCallback<T>;
  private readonly filters: readonly ResolvedFilter[];
  private readonly externalIdSourceField: string;
  private readonly source: ChangeSource;
  private readonly composed: ChangeIterator<T>;

  constructor(opts: PollChangeSourceOptions<T>) {
    if (opts.config.mode !== 'poll') {
      throw new Error(
        `PollChangeSource requires DetectionConfig.mode === 'poll'; got '${(opts.config as { mode: string }).mode}'`,
      );
    }
    const config = opts.config;

    // Field mapping: locate the canonical `external_id` target. Adapters
    // emit T already-mapped, but the primitive needs to know which key on
    // T carries the external id so it can stamp `Change.externalId`. Source
    // of truth is the mapping table — codegen emits it from YAML, the
    // primitive reads it here.
    const externalIdMapping = config.mapping.find(
      (m) => m.target === 'external_id',
    );
    if (!externalIdMapping) {
      throw new Error(
        "PollChangeSource: DetectionConfig.mapping must include an entry with target 'external_id' so emitted Change<T>.externalId can be populated",
      );
    }
    this.externalIdSourceField = externalIdMapping.target;

    this.adapter = opts.adapter;
    this.filters = config.filters;
    // Provenance: `mode: 'poll'` defaults to `'poll'`; opt into `'cdc'` via
    // `poll.provenance` (Stripe-style event endpoints — wired in #226-4).
    this.source = config.poll.provenance === 'cdc' ? 'cdc' : 'poll';

    this.label =
      opts.label ?? `poll-change-source:${externalIdMapping.source}`;

    // Compose middleware chain. The terminal iterator is `this.fetch`
    // bound to `this`. First middleware in the array is the outermost
    // layer (sees subscription/cursor first, yielded changes last).
    const inner: ChangeIterator<T> = (sub, cur) => this.fetch(sub, cur);
    const middlewares = opts.middlewares ?? [];
    this.composed = middlewares.reduceRight<ChangeIterator<T>>(
      (next, mw) => mw(next),
      inner,
    );
  }

  listChanges(
    subscription: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>> {
    return this.composed(subscription, cursor);
  }

  private async *fetch(
    subscription: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>> {
    const ctx: PollFetchContext = {
      subscription,
      cursor: cursor as PollCursor | null,
      filters: this.filters,
    };

    for await (const { record, cursor: nextCursor } of this.adapter(ctx)) {
      const externalIdRaw = (record as Record<string, unknown>)[
        this.externalIdSourceField
      ];
      if (typeof externalIdRaw !== 'string' || externalIdRaw.length === 0) {
        throw new Error(
          `PollChangeSource: record missing string '${this.externalIdSourceField}' — emitted records MUST carry the canonical external id keyed by the mapping target`,
        );
      }
      const change: Change<T> = {
        externalId: externalIdRaw,
        // Polling cannot distinguish create vs. update vs. delete on its
        // own — all yielded records are surfaced as 'updated'. The
        // orchestrator's diff stage classifies create-vs-update against
        // local state; soft-delete detection is out of scope for the
        // primitive (consumer drives via tombstone records or a separate
        // sweep — see ADR-033).
        operation: 'updated',
        record,
        cursor: nextCursor,
        source: this.source,
      };
      yield change;
    }
  }
}
