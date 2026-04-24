/**
 * IObservabilityService — core contract for the observability subsystem
 * (ADR-008, 5th subsystem in the infrastructure family alongside events,
 * jobs, cache, storage).
 *
 * The contract is a **read-only reflection surface** over framework-owned
 * tables (`job_run`, `bridge_delivery`, `domain_events`, `sync_runs`,
 * `sync_subscriptions`). The subsystem itself owns no tables — it's a query
 * facade over state the other subsystems already persist.
 *
 * # Core + extensions (per CLAUDE.md "Backend swappability")
 *
 * The five methods below are the **core contract** — every backend MUST
 * implement them. App code that calls only these is portable across
 * backends (drizzle / memory / future OpenTelemetry exporter / etc).
 *
 * Backend-specific capabilities (e.g. Postgres `pg_stat_activity` sampling,
 * an OTel span exporter, a Prometheus scrape endpoint) are exposed as
 * **extensions** on the concrete backend class, not lifted into this
 * interface. Consumers opting into extensions accept backend-specific
 * coupling — that's the whole point; the core contract is what guarantees
 * portability.
 *
 * # The five core methods
 *
 * Finalized against two concrete consumers in `dealbrain-v2`:
 *   - `BridgeMetricsReporter` (60s sampler over `bridge_delivery`)
 *   - `StackStatusService` (on-demand `GET /dev/status` snapshot).
 *
 * Every distinct SQL query those two files run is covered by one of these
 * five methods (or relocated entirely — see `reporters/`).
 */
export interface IObservabilityService {
  /**
   * Current pool depths for the jobs subsystem.
   *
   * One row per pool that has at least one pending or running `job_run`.
   * Empty pools (no activity) are omitted — the surface is "what's
   * active", not a pool-config dump.
   *
   * `claimedAgeP95Ms` is the p95 of `(now - claimed_at)` in milliseconds
   * over currently-running runs, or `null` when the pool has no running
   * runs. Useful for spotting stuck workers.
   */
  getPoolDepths(): Promise<PoolDepth[]>;

  /**
   * Recent sync_runs, most-recent-first.
   *
   * When `integrationId` is provided, the query filters to that integration;
   * when omitted, returns the N most recent runs across all integrations.
   * For "last N per integration" fan-out, callers run the method per
   * integration id rather than adding a per-group LATERAL variant to the
   * core — LATERAL is a Postgres-ism that doesn't port cleanly to memory
   * or hypothetical OTel/Redis backends.
   *
   * @param limit cap on rows returned
   * @param integrationId optional integration filter
   */
  getRecentSyncRuns(
    limit: number,
    integrationId?: string,
  ): Promise<SyncRunSummary[]>;

  /**
   * Count of `bridge_delivery` rows grouped by terminal status over a
   * trailing window.
   *
   * The window is measured against `COALESCE(delivered_at, attempted_at)`
   * so terminal `skipped` / `failed` rows are counted alongside
   * `delivered`. Rows still `pending` at query time appear under
   * `'pending'` if they fall in the window.
   *
   * @param windowHours trailing window size; typical values are 1h
   * (dashboards) or 24h (daily summary).
   */
  getBridgeDeliveryHistogram(windowHours: number): Promise<StatusHistogram>;

  /**
   * Most recent `job_run` rows with `status = 'failed'`, newest-first.
   *
   * Intended for on-demand ops drill-down (dashboard panel, `/dev/status`
   * endpoint). Consumers that need structured alerting should subscribe to
   * job events via the jobs subsystem directly rather than polling this.
   */
  getRecentFailedJobs(limit: number): Promise<JobRunFailure[]>;

  /**
   * Cursor state per enabled `sync_subscriptions` row.
   *
   * Returns the opaque cursor payload verbatim — strategies type it
   * internally (poll: `{ systemModstamp }`, cdc: `{ replayId }`, webhook:
   * `{ ts }`), but the observability surface stays untyped so it works
   * across adapter shapes.
   */
  getCursors(): Promise<CursorSnapshot[]>;
}

// ─── Return shapes ───────────────────────────────────────────────────────

export interface PoolDepth {
  /** Pool name (matches `job_run.pool`). */
  name: string;
  /** Count of `status = 'pending'` runs. */
  pending: number;
  /** Count of `status = 'running'` runs. */
  running: number;
  /**
   * p95 of `now - claimed_at` in ms over currently-running runs, or null
   * when the pool has no running runs.
   */
  claimedAgeP95Ms: number | null;
}

export interface SyncRunSummary {
  id: string;
  /** Subscription id the run belongs to (FK → `sync_subscriptions.id`). */
  subscriptionId: string;
  /**
   * Integration id — recovered via join on `sync_subscriptions` so
   * consumers don't have to re-hydrate the subscription to answer
   * "which integration ran?".
   */
  integrationId: string | null;
  /** Adapter label from the subscription (e.g. `'salesforce'`). */
  adapter: string | null;
  /** Domain label from the subscription (e.g. `'opportunity'`). */
  domain: string | null;
  direction: string;
  action: string;
  status: string;
  recordsFound: number;
  recordsProcessed: number;
  durationMs: number | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * Histogram of bridge-delivery rows keyed by status. Keys are a subset of
 * `'pending' | 'delivered' | 'skipped' | 'failed'`; statuses with zero
 * rows in the window are omitted.
 */
export type StatusHistogram = Record<string, number>;

export interface JobRunFailure {
  id: string;
  jobType: string;
  pool: string;
  status: string;
  error: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  attempts: number;
}

export interface CursorSnapshot {
  /** `sync_subscriptions.id`. */
  subscriptionId: string;
  integrationId: string;
  adapter: string;
  domain: string;
  /** Opaque cursor payload; null until the first successful run advances it. */
  lastCursor: unknown;
  lastSyncAt: Date | null;
}
