/**
 * IObservability — read-only composer port for the observability combiner
 * subsystem (ADR-025, OBS-5).
 *
 * Every method:
 *   - Accepts an optional `tenantId`, passed VERBATIM to the owning sibling
 *     port. Observability never re-implements tenant filtering — that is
 *     the owning subsystem's job (jobs / bridge / integration). See
 *     `.claude/skills/observability/SKILL.md` §3.
 *       - `undefined` — "not provided"; sibling default semantics apply.
 *       - `null`      — explicit cross-tenant match (sibling-specific).
 *       - `string`    — filter to that single tenant.
 *   - Returns an empty shape (not throws) when the owning sibling port is
 *     absent in the consumer's DI container. Consumers get a graceful
 *     degradation instead of a boot failure.
 *
 * Phase-1 scope (epic #195): five reads composed from four sibling ports.
 * Cross-subsystem JOIN analytics belong to the semantic query layer
 * (query-surface over the generated semantic model, ADR-045; skill §5).
 */

import type {
  EventPage,
  EventSummary,
  ListEventsQuery,
} from '../events/event-read.protocol';
import type { StatusHistogram } from '../bridge/bridge.protocol';
import type { IntegrationRunSummary } from '../integration/integration-run-recorder.protocol';
import type { CursorSnapshot } from '../integration/integration-cursor-store.protocol';

/**
 * One chronological entry in a correlation timeline (OBS-LIST-1): a `domain_event` sharing the `rootRunId`. Job runs
 * left the timeline with ADR-022 (JOBS-3): a run's tree is `@pattern-stack/jobs`' own (`JobsService`'s operator view).
 */
export type CorrelationTimelineEntry = { kind: 'event'; at: Date; event: EventSummary };

/**
 * Stitched view of everything correlated to a single `rootRunId`
 * (OBS-LIST-1): the job runs sharing that root plus the domain events whose
 * `metadata.rootRunId` matches, merged into one ascending timeline with a
 * small roll-up summary.
 */
export interface CorrelationTimeline {
  rootRunId: string;
  /** Ascending by `at` (an event's `occurredAt`). */
  entries: CorrelationTimelineEntry[];
  summary: {
    eventCount: number;
    /** Earliest `at` across all entries, or `null` when empty. */
    startedAt: Date | null;
    /** Latest `at` across all entries, or `null` when empty. */
    lastActivityAt: Date | null;
  };
}

export interface IObservability {
  /**
   * Bridge-delivery status counts over a trailing window. Delegates to
   * `IJobBridge.getStatusHistogram`.
   *
   * Returns an all-zero histogram (`{ pending: 0, delivered: 0, skipped: 0,
   * failed: 0 }`) when the bridge subsystem is not installed — matches the
   * bridge protocol's "fixed keys, zero-filled" contract.
   */
  getBridgeDeliveryHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram>;

  /**
   * Recent `integration_runs` (optionally filtered by subscription). Delegates to
   * `IIntegrationRunRecorder.listRecent`.
   *
   * Empty array when the integration subsystem is not installed.
   */
  getRecentIntegrationRuns(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<IntegrationRunSummary[]>;

  /**
   * Cursor state per enabled `integration_subscriptions` row. Delegates to
   * `ICursorStore.listAll`.
   *
   * Empty array when the integration subsystem is not installed.
   */
  getCursors(tenantId?: string | null): Promise<CursorSnapshot[]>;

  /**
   * Paginated, filterable `domain_events` list (OBS-LIST-1). Delegates to
   * `IEventReadPort.listEvents`. Keyset pagination on `occurred_at`.
   *
   * Returns an empty page when the events read port is not installed (e.g.
   * the events subsystem is absent, or its backend is `redis` which retains
   * no history).
   */
  listEvents(query?: ListEventsQuery): Promise<EventPage>;

  /**
   * The domain events sharing a `rootRunId`, as one ascending timeline + summary (OBS-LIST-1), from
   * `IEventReadPort.listEvents({ rootRunId })`. Empty (zero counts, null bounds) without the events read port.
   */
  getCorrelationTimeline(
    rootRunId: string,
    tenantId?: string | null,
  ): Promise<CorrelationTimeline>;
}

// Re-export composed return types so consumers of IObservability can import
// them from a single module without reaching into every sibling subsystem.
export type {
  EventSummary,
  EventPage,
  ListEventsQuery,
  StatusHistogram,
  IntegrationRunSummary,
  CursorSnapshot,
};
