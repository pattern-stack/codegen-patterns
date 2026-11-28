/**
 * ObservabilityService — `IObservability` combiner implementation
 * (ADR-025, OBS-5).
 *
 * Composes read methods across the jobs, bridge, and integration subsystems via
 * DI. Owns no state, no schema, no SQL. Every method is a one-line
 * delegation to the sibling port that already encodes the semantics.
 *
 * # Missing-port degradation
 *
 * Every sibling is injected with `@Optional()`. When the consumer's app
 * has not wired a given subsystem, the corresponding field is `undefined`
 * and the delegating method returns an empty shape:
 *   - array methods return `[]`
 *   - `getBridgeDeliveryHistogram` returns `{ pending: 0, delivered: 0,
 *     skipped: 0, failed: 0 }` (matches the bridge protocol's fixed-keys
 *     contract so consumers can render a 4-row chart unconditionally).
 *
 * Graceful absence is the whole point of the combiner pattern (ADR-025
 * §Shape, constraint 3) — a consumer that only installed the jobs
 * subsystem can still inject `OBSERVABILITY` and get useful job reads
 * without wiring the rest.
 *
 * # Multi-tenancy
 *
 * `tenantId` passes VERBATIM from the public method to the owning port.
 * `ObservabilityService` never re-implements tenant filtering. See
 * `.claude/skills/observability/SKILL.md` §3 and ADR-025.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';


import { EVENT_READ_PORT } from '../events/events.tokens';
import type {
  EventPage,
  EventSummary,
  IEventReadPort,
  ListEventsQuery,
} from '../events/event-read.protocol';

import { BRIDGE_DELIVERY_REPO } from '../bridge/bridge.tokens';
import type { IJobBridge, StatusHistogram } from '../bridge/bridge.protocol';

import { INTEGRATION_CURSOR_STORE, INTEGRATION_RUN_RECORDER } from '../integration/integration.tokens';
import type {
  IIntegrationRunRecorder,
  IntegrationRunSummary,
} from '../integration/integration-run-recorder.protocol';
import type {
  CursorSnapshot,
  ICursorStore,
} from '../integration/integration-cursor-store.protocol';

import type {
  CorrelationTimeline,
  CorrelationTimelineEntry,
  IObservability,
} from './observability.protocol';

/**
 * Safety bound on how many pages the correlation timeline will walk when
 * draining a sibling port. A single run tree producing more than
 * 50 pages × default page size of correlated rows is pathological; cap to
 * keep the stitch bounded rather than unbounded-loop on bad data.
 */
const MAX_TIMELINE_PAGES = 50;

@Injectable()
export class ObservabilityService implements IObservability {
  /**
   * All-zero histogram used when the bridge subsystem is absent. Matches
   * the bridge protocol's "fixed keys, zero-filled" contract so consumers
   * never branch on presence.
   */
  private static readonly EMPTY_HISTOGRAM: StatusHistogram = {
    pending: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
  };

  /** Empty page used when a sibling read port is absent. */
  private static readonly EMPTY_EVENT_PAGE: EventPage = {
    items: [],
    nextCursor: null,
  };

  constructor(
    @Optional()
    @Inject(BRIDGE_DELIVERY_REPO)
    private readonly bridge?: IJobBridge,
    @Optional()
    @Inject(INTEGRATION_RUN_RECORDER)
    private readonly integrationRuns?: IIntegrationRunRecorder,
    @Optional()
    @Inject(INTEGRATION_CURSOR_STORE)
    private readonly cursors?: ICursorStore,
    @Optional()
    @Inject(EVENT_READ_PORT)
    private readonly events?: IEventReadPort | null,
  ) {}

  async getBridgeDeliveryHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram> {
    if (!this.bridge) return { ...ObservabilityService.EMPTY_HISTOGRAM };
    return this.bridge.getStatusHistogram(windowHours, tenantId);
  }

  async getRecentIntegrationRuns(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<IntegrationRunSummary[]> {
    if (!this.integrationRuns) return [];
    return this.integrationRuns.listRecent(limit, subscriptionId, tenantId);
  }

  async getCursors(tenantId?: string | null): Promise<CursorSnapshot[]> {
    if (!this.cursors) return [];
    return this.cursors.listAll(tenantId);
  }

  async listEvents(query?: ListEventsQuery): Promise<EventPage> {
    if (!this.events) {
      return { ...ObservabilityService.EMPTY_EVENT_PAGE };
    }
    return this.events.listEvents(query);
  }

  async getCorrelationTimeline(
    rootRunId: string,
    tenantId?: string | null,
  ): Promise<CorrelationTimeline> {
    const events = await this.collectEvents(rootRunId, tenantId);
    const entries: CorrelationTimelineEntry[] = events
      .map((event): CorrelationTimelineEntry => ({ kind: 'event', at: event.occurredAt, event }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const startedAt = entries.length > 0 ? entries[0]!.at : null;
    const lastActivityAt =
      entries.length > 0 ? entries[entries.length - 1]!.at : null;

    return {
      rootRunId,
      entries,
      summary: {
        eventCount: events.length,
        startedAt,
        lastActivityAt,
      },
    };
  }

  /**
   * Drain every `domain_event` whose `metadata.rootRunId` matches by walking
   * the keyset cursor. Empty when the events read port is absent.
   */
  private async collectEvents(
    rootRunId: string,
    tenantId?: string | null,
  ): Promise<EventSummary[]> {
    if (!this.events) return [];
    const out: EventSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TIMELINE_PAGES; page += 1) {
      const result = await this.events.listEvents({
        rootRunId,
        tenantId,
        cursor,
      });
      out.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return out;
  }
}
