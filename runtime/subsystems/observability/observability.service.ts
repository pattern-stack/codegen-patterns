/**
 * ObservabilityService — `IObservability` combiner implementation
 * (ADR-025, OBS-5).
 *
 * Composes read methods across the jobs, bridge, and sync subsystems via
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

import { JOB_RUN_SERVICE } from '../jobs/jobs-domain.tokens';
import type {
  IJobRunService,
  JobRunFailure,
  PoolStatusCount,
} from '../jobs/job-run-service.protocol';

import { BRIDGE_DELIVERY_REPO } from '../bridge/bridge.tokens';
import type { IJobBridge, StatusHistogram } from '../bridge/bridge.protocol';

import { SYNC_CURSOR_STORE, SYNC_RUN_RECORDER } from '../sync/sync.tokens';
import type {
  ISyncRunRecorder,
  SyncRunSummary,
} from '../sync/sync-run-recorder.protocol';
import type {
  CursorSnapshot,
  ICursorStore,
} from '../sync/sync-cursor-store.protocol';

import type { IObservability } from './observability.protocol';

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

  constructor(
    @Optional()
    @Inject(JOB_RUN_SERVICE)
    private readonly jobRuns?: IJobRunService,
    @Optional()
    @Inject(BRIDGE_DELIVERY_REPO)
    private readonly bridge?: IJobBridge,
    @Optional()
    @Inject(SYNC_RUN_RECORDER)
    private readonly syncRuns?: ISyncRunRecorder,
    @Optional()
    @Inject(SYNC_CURSOR_STORE)
    private readonly cursors?: ICursorStore,
  ) {}

  async getPoolDepths(tenantId?: string | null): Promise<PoolStatusCount[]> {
    if (!this.jobRuns) return [];
    return this.jobRuns.countByPoolAndStatus(tenantId);
  }

  async getRecentFailedJobs(
    limit: number,
    tenantId?: string | null,
  ): Promise<JobRunFailure[]> {
    if (!this.jobRuns) return [];
    return this.jobRuns.listRecentFailed(limit, tenantId);
  }

  async getBridgeDeliveryHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram> {
    if (!this.bridge) return { ...ObservabilityService.EMPTY_HISTOGRAM };
    return this.bridge.getStatusHistogram(windowHours, tenantId);
  }

  async getRecentSyncRuns(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<SyncRunSummary[]> {
    if (!this.syncRuns) return [];
    return this.syncRuns.listRecent(limit, subscriptionId, tenantId);
  }

  async getCursors(tenantId?: string | null): Promise<CursorSnapshot[]> {
    if (!this.cursors) return [];
    return this.cursors.listAll(tenantId);
  }
}
