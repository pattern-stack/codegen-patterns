/**
 * Sync subsystem — change-source protocol (port)
 *
 * `IChangeSource<T>` is the hexagonal port every sync adapter implements.
 * Use cases inject this interface via `SYNC_CHANGE_SOURCE` token. They never
 * depend on a specific backend implementation.
 *
 * Three detection modes (poll / cdc / webhook) converge on this single port
 * per ADR-0002 (the upstream consumer). Per-mode differences live in the
 * `Change.source` / `dedupKey` / `providerChangedFields` metadata fields,
 * not in separate ports.
 *
 * Cursor is passed by-value as the second argument (#226-2 / ADR-033). The
 * orchestrator owns cursor lifecycle (read-before-iterate, advance-on-yield,
 * persist-on-success); the primitive receives the current value at the start
 * of each run rather than reading it from a side store. This eliminates the
 * "two readers of the same row" problem that arose when adapters injected
 * `ICursorStore` directly.
 *
 * See epic #60 (parent), ADR-033 (config-driven change sources), and
 * upstream ADR-008 subsystem architecture.
 */

// ============================================================================
// Change provenance + shape
// ============================================================================

/**
 * Provenance of a change record. Maps 1:1 to `sync_runs.action` so run logs
 * self-identify.
 */
export type ChangeSource = 'poll' | 'cdc' | 'webhook';

/**
 * One upstream change, normalized.
 *
 * The adapter has already translated provider-specific record shape into a
 * canonical T. Custom fields flow through the `fields` bag on `record` when
 * T supports it (adapters attach it; the sink splits and routes).
 *
 * `dedupKey` — set by CDC (replay_id) and webhook (event_id) paths; absent
 * for polling. Orchestrator uses it for idempotent re-delivery when present,
 * falls back to fingerprint-comparison otherwise.
 *
 * `providerChangedFields` — CDC-only. Lets the differ skip deep-equals when
 * the provider already told us which fields moved; falls back to computed
 * diff when absent.
 *
 * `cursor` — opaque at this seam. Each strategy types it internally (poll:
 * `{ systemModstamp }`, CDC: `{ replayId }`, webhook: `{ ts }`) and the
 * orchestrator persists whatever the strategy last yielded.
 */
export interface Change<T> {
  readonly externalId: string;
  readonly operation: 'created' | 'updated' | 'deleted';
  readonly record: T;
  readonly cursor: unknown;
  readonly source: ChangeSource;
  readonly dedupKey?: string;
  readonly providerChangedFields?: string[];
}

// ============================================================================
// Subscription shape (structural — consumer owns the row)
// ============================================================================

/**
 * Minimal structural view of a sync-subscription row the port needs.
 *
 * The consumer owns the concrete `sync_subscriptions` table (schema lands in
 * SYNC-1). This interface captures only the fields the port itself reads, so
 * adapters can be typed without depending on the consumer's ORM row type.
 */
export interface SyncSubscriptionView {
  /** Primary key — addresses the cursor in `ICursorStore`. */
  readonly id: string;
  /** Canonical entity domain, e.g. `'opportunity'`, `'contact'`. */
  readonly domain: string;
  /** Optional external reference — the upstream "scope" for this subscription. */
  readonly externalRef?: string | null;
}

// ============================================================================
// IChangeSource
// ============================================================================

/**
 * The one port every sync adapter implements. Mode-specific concerns
 * (scheduling, rate-limiting, ack contracts, credential refresh) stay in the
 * strategy class that implements this interface — this seam is deliberately
 * minimal.
 *
 * Strategies are per-provider per-mode per-entity — one concrete class per
 * `(provider, detection-mode, canonical-entity)` tuple.
 */
export interface IChangeSource<T> {
  /** Human label for run logs — e.g. `'salesforce-poll-opportunity'`. */
  readonly label: string;

  /**
   * Async-iterate upstream changes, newest cursor last. The orchestrator
   * passes the current persisted cursor by-value as the second argument and
   * persists `change.cursor` as it advances; strategies MUST yield at least
   * one change before the async iterable completes if anything changed
   * upstream, otherwise cursor advance is a no-op.
   *
   * `cursor` is opaque at this seam — the primitive's cursor strategy types
   * it internally. `null` means "first run, no cursor yet."
   */
  listChanges(
    subscription: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>>;
}
