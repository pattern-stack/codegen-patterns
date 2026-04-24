/**
 * Unit tests for `ObservabilityService` — the combiner subsystem's sole
 * implementation class (ADR-025, OBS-5).
 *
 * Three axes of coverage:
 *   1. Delegation — each `IObservability` method hands off to the correct
 *      sibling port and returns the composed shape verbatim.
 *   2. Missing-port degradation — when a sibling port is absent (i.e. the
 *      consumer didn't wire that subsystem), the method returns an empty
 *      shape instead of throwing.
 *   3. Tenant passthrough — `tenantId` (including explicit `null` and
 *      `undefined`) reaches the sibling port unchanged. Observability
 *      NEVER re-implements tenant filtering; this test is the invariant's
 *      enforcement point.
 *
 * Uses inline fake implementations of each sibling port. Wiring the real
 * memory backends would require threading module-level deps
 * (`JOB_ORCHESTRATOR`, `JOBS_MULTI_TENANT`, `MemoryJobStore`, etc.) that
 * are orthogonal to what these tests verify.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';

import {
  OBSERVABILITY,
  type CursorSnapshot,
  type IObservability,
  type JobRunFailure,
  type PoolStatusCount,
  type StatusHistogram,
  type SyncRunSummary,
} from '../../../../runtime/subsystems/observability';
import { ObservabilityService } from '../../../../runtime/subsystems/observability/observability.service';

import { JOB_RUN_SERVICE } from '../../../../runtime/subsystems/jobs/jobs-domain.tokens';
import type {
  IJobRunService,
  JobRun,
} from '../../../../runtime/subsystems/jobs/job-orchestrator.protocol';
// Protocol imports needed for type casts below.
import type { IJobRunService as _JobRunServiceAlias } from '../../../../runtime/subsystems/jobs/job-run-service.protocol';

import { BRIDGE_DELIVERY_REPO } from '../../../../runtime/subsystems/bridge/bridge.tokens';
import type { IJobBridge } from '../../../../runtime/subsystems/bridge/bridge.protocol';

import {
  SYNC_CURSOR_STORE,
  SYNC_RUN_RECORDER,
} from '../../../../runtime/subsystems/sync/sync.tokens';
import type { ISyncRunRecorder } from '../../../../runtime/subsystems/sync/sync-run-recorder.protocol';
import type { ICursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.protocol';

// ─── Fake sibling ports ──────────────────────────────────────────────────
// Minimal stubs: record the arguments they were called with, return seeded
// fixtures. Shapes match the protocols from main; unused methods throw so
// accidental callers surface immediately.

type CallRecord = {
  method: string;
  args: readonly unknown[];
};

class FakeJobRunService implements _JobRunServiceAlias {
  calls: CallRecord[] = [];
  poolCounts: PoolStatusCount[] = [];
  failures: JobRunFailure[] = [];

  listForScope(): Promise<JobRun[]> {
    throw new Error('not used');
  }
  cancelForScope(): Promise<void> {
    throw new Error('not used');
  }
  rescheduleForScope(): Promise<void> {
    throw new Error('not used');
  }

  async countByPoolAndStatus(
    tenantId?: string | null,
  ): Promise<PoolStatusCount[]> {
    this.calls.push({ method: 'countByPoolAndStatus', args: [tenantId] });
    return this.poolCounts;
  }

  async listRecentFailed(
    limit: number,
    tenantId?: string | null,
  ): Promise<JobRunFailure[]> {
    this.calls.push({
      method: 'listRecentFailed',
      args: [limit, tenantId],
    });
    return this.failures;
  }
}

class FakeBridge implements IJobBridge {
  calls: CallRecord[] = [];
  histogram: StatusHistogram = {
    pending: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
  };

  insertDelivery(): Promise<void> {
    throw new Error('not used');
  }
  findDelivery(): Promise<null> {
    throw new Error('not used');
  }
  findDeliveryById(): Promise<null> {
    throw new Error('not used');
  }
  markDelivered(): Promise<void> {
    throw new Error('not used');
  }
  markSkipped(): Promise<void> {
    throw new Error('not used');
  }
  markFailed(): Promise<void> {
    throw new Error('not used');
  }

  async getStatusHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram> {
    this.calls.push({ method: 'getStatusHistogram', args: [windowHours, tenantId] });
    return this.histogram;
  }
}

class FakeRunRecorder implements ISyncRunRecorder {
  calls: CallRecord[] = [];
  summaries: SyncRunSummary[] = [];

  startRun(): Promise<{ id: string }> {
    throw new Error('not used');
  }
  recordItem(): Promise<void> {
    throw new Error('not used');
  }
  completeRun(): Promise<void> {
    throw new Error('not used');
  }

  async listRecent(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<SyncRunSummary[]> {
    this.calls.push({
      method: 'listRecent',
      args: [limit, subscriptionId, tenantId],
    });
    return this.summaries;
  }
}

class FakeCursorStore implements ICursorStore {
  calls: CallRecord[] = [];
  snapshots: CursorSnapshot[] = [];

  get(): Promise<unknown | null> {
    throw new Error('not used');
  }
  put(): Promise<void> {
    throw new Error('not used');
  }

  async listAll(tenantId?: string | null): Promise<CursorSnapshot[]> {
    this.calls.push({ method: 'listAll', args: [tenantId] });
    return this.snapshots;
  }
}

// Fixtures ---------------------------------------------------------------

const POOL_COUNTS: PoolStatusCount[] = [
  { pool: 'interactive', status: 'pending', count: 3 },
  { pool: 'interactive', status: 'running', count: 1 },
  { pool: 'batch', status: 'pending', count: 9 },
];

const FAILURES: JobRunFailure[] = [
  {
    runId: 'run-1',
    jobType: 'send_email',
    pool: 'interactive',
    scopeEntityType: null,
    scopeEntityId: null,
    tenantId: null,
    attempts: 3,
    errorMessage: 'smtp timeout',
    failedAt: new Date('2026-04-22T10:00:00Z'),
    createdAt: new Date('2026-04-22T09:59:00Z'),
  },
];

const HISTOGRAM: StatusHistogram = {
  pending: 2,
  delivered: 10,
  skipped: 1,
  failed: 0,
};

const SYNC_SUMMARIES: SyncRunSummary[] = [
  {
    id: 'run-a',
    subscriptionId: 'sub-1',
    integrationId: 'int-1',
    status: 'success',
    startedAt: new Date('2026-04-22T10:00:00Z'),
    completedAt: new Date('2026-04-22T10:00:05Z'),
    recordsProcessed: 42,
    tenantId: 'tenant-x',
  },
];

const CURSOR_SNAPSHOTS: CursorSnapshot[] = [
  {
    subscriptionId: 'sub-1',
    integrationId: 'int-1',
    adapter: 'salesforce',
    domain: 'opportunity',
    externalRef: null,
    cursor: { systemModstamp: '2026-04-22T09:59:00Z' },
    lastSyncAt: new Date('2026-04-22T10:00:00Z'),
    updatedAt: new Date('2026-04-22T10:00:00Z'),
    tenantId: 'tenant-x',
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

async function buildModule(opts: {
  jobRuns?: FakeJobRunService;
  bridge?: FakeBridge;
  syncRuns?: FakeRunRecorder;
  cursors?: FakeCursorStore;
}) {
  const providers: import('@nestjs/common').Provider[] = [ObservabilityService];
  if (opts.jobRuns)
    providers.push({ provide: JOB_RUN_SERVICE, useValue: opts.jobRuns });
  if (opts.bridge)
    providers.push({ provide: BRIDGE_DELIVERY_REPO, useValue: opts.bridge });
  if (opts.syncRuns)
    providers.push({ provide: SYNC_RUN_RECORDER, useValue: opts.syncRuns });
  if (opts.cursors)
    providers.push({ provide: SYNC_CURSOR_STORE, useValue: opts.cursors });

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const obs = moduleRef.get(ObservabilityService) as IObservability;
  return { moduleRef, obs };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('ObservabilityService — delegation', () => {
  let jobRuns: FakeJobRunService;
  let bridge: FakeBridge;
  let syncRuns: FakeRunRecorder;
  let cursors: FakeCursorStore;
  let obs: IObservability;

  beforeEach(async () => {
    jobRuns = new FakeJobRunService();
    jobRuns.poolCounts = POOL_COUNTS;
    jobRuns.failures = FAILURES;

    bridge = new FakeBridge();
    bridge.histogram = HISTOGRAM;

    syncRuns = new FakeRunRecorder();
    syncRuns.summaries = SYNC_SUMMARIES;

    cursors = new FakeCursorStore();
    cursors.snapshots = CURSOR_SNAPSHOTS;

    ({ obs } = await buildModule({ jobRuns, bridge, syncRuns, cursors }));
  });

  it('getPoolDepths() returns IJobRunService.countByPoolAndStatus result verbatim', async () => {
    const result = await obs.getPoolDepths();
    expect(result).toEqual(POOL_COUNTS);
    expect(jobRuns.calls).toEqual([
      { method: 'countByPoolAndStatus', args: [undefined] },
    ]);
  });

  it('getRecentFailedJobs(limit) delegates with the same limit', async () => {
    const result = await obs.getRecentFailedJobs(5);
    expect(result).toEqual(FAILURES);
    expect(jobRuns.calls).toEqual([
      { method: 'listRecentFailed', args: [5, undefined] },
    ]);
  });

  it('getBridgeDeliveryHistogram(windowHours) delegates to IJobBridge.getStatusHistogram', async () => {
    const result = await obs.getBridgeDeliveryHistogram(24);
    expect(result).toEqual(HISTOGRAM);
    expect(bridge.calls).toEqual([
      { method: 'getStatusHistogram', args: [24, undefined] },
    ]);
  });

  it('getRecentSyncRuns(limit, subscriptionId) delegates all args', async () => {
    const result = await obs.getRecentSyncRuns(10, 'sub-1');
    expect(result).toEqual(SYNC_SUMMARIES);
    expect(syncRuns.calls).toEqual([
      { method: 'listRecent', args: [10, 'sub-1', undefined] },
    ]);
  });

  it('getCursors() delegates to ICursorStore.listAll', async () => {
    const result = await obs.getCursors();
    expect(result).toEqual(CURSOR_SNAPSHOTS);
    expect(cursors.calls).toEqual([{ method: 'listAll', args: [undefined] }]);
  });
});

describe('ObservabilityService — missing-port degradation', () => {
  it('constructs with zero siblings wired (no throw)', async () => {
    // Resolve via the Nest DI container — mirrors what happens when a
    // consumer registers ObservabilityModule without any sibling modules.
    const { moduleRef, obs } = await buildModule({});
    expect(obs).toBeInstanceOf(ObservabilityService);
    await moduleRef.close();
  });

  it('getPoolDepths() returns [] when JOB_RUN_SERVICE is absent', async () => {
    const { obs } = await buildModule({});
    expect(await obs.getPoolDepths()).toEqual([]);
  });

  it('getRecentFailedJobs() returns [] when JOB_RUN_SERVICE is absent', async () => {
    const { obs } = await buildModule({});
    expect(await obs.getRecentFailedJobs(10)).toEqual([]);
  });

  it('getBridgeDeliveryHistogram() returns all-zero histogram when BRIDGE_DELIVERY_REPO is absent', async () => {
    const { obs } = await buildModule({});
    const result = await obs.getBridgeDeliveryHistogram(1);
    // Fixed keys, zero-filled — matches the bridge protocol contract so
    // callers can render a 4-row chart unconditionally.
    expect(result).toEqual({ pending: 0, delivered: 0, skipped: 0, failed: 0 });
  });

  it('getRecentSyncRuns() returns [] when SYNC_RUN_RECORDER is absent', async () => {
    const { obs } = await buildModule({});
    expect(await obs.getRecentSyncRuns(5)).toEqual([]);
  });

  it('getCursors() returns [] when SYNC_CURSOR_STORE is absent', async () => {
    const { obs } = await buildModule({});
    expect(await obs.getCursors()).toEqual([]);
  });

  it('per-sibling absence is independent — present siblings still delegate', async () => {
    const jobRuns = new FakeJobRunService();
    jobRuns.poolCounts = POOL_COUNTS;
    const { obs } = await buildModule({ jobRuns });

    expect(await obs.getPoolDepths()).toEqual(POOL_COUNTS);
    expect(await obs.getBridgeDeliveryHistogram(1)).toEqual({
      pending: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
    });
    expect(await obs.getCursors()).toEqual([]);
  });
});

describe('ObservabilityService — tenant passthrough', () => {
  // Every method accepts tenantId verbatim; the service must not substitute,
  // coerce, or strip. This is the SKILL.md §3 invariant: observability
  // NEVER re-implements tenant filtering.

  let jobRuns: FakeJobRunService;
  let bridge: FakeBridge;
  let syncRuns: FakeRunRecorder;
  let cursors: FakeCursorStore;
  let obs: IObservability;

  beforeEach(async () => {
    jobRuns = new FakeJobRunService();
    bridge = new FakeBridge();
    syncRuns = new FakeRunRecorder();
    cursors = new FakeCursorStore();
    ({ obs } = await buildModule({ jobRuns, bridge, syncRuns, cursors }));
  });

  it('forwards string tenantId verbatim on every method', async () => {
    await obs.getPoolDepths('tenant-a');
    await obs.getRecentFailedJobs(3, 'tenant-a');
    await obs.getBridgeDeliveryHistogram(12, 'tenant-a');
    await obs.getRecentSyncRuns(5, 'sub-1', 'tenant-a');
    await obs.getCursors('tenant-a');

    expect(jobRuns.calls).toEqual([
      { method: 'countByPoolAndStatus', args: ['tenant-a'] },
      { method: 'listRecentFailed', args: [3, 'tenant-a'] },
    ]);
    expect(bridge.calls).toEqual([
      { method: 'getStatusHistogram', args: [12, 'tenant-a'] },
    ]);
    expect(syncRuns.calls).toEqual([
      { method: 'listRecent', args: [5, 'sub-1', 'tenant-a'] },
    ]);
    expect(cursors.calls).toEqual([{ method: 'listAll', args: ['tenant-a'] }]);
  });

  it('forwards explicit null tenantId (cross-tenant semantics) verbatim', async () => {
    await obs.getPoolDepths(null);
    await obs.getBridgeDeliveryHistogram(1, null);
    await obs.getCursors(null);

    expect(jobRuns.calls[0]).toEqual({
      method: 'countByPoolAndStatus',
      args: [null],
    });
    expect(bridge.calls[0]).toEqual({
      method: 'getStatusHistogram',
      args: [1, null],
    });
    expect(cursors.calls[0]).toEqual({ method: 'listAll', args: [null] });
  });

  it('forwards undefined tenantId as undefined (sibling default)', async () => {
    await obs.getPoolDepths();
    await obs.getRecentSyncRuns(10);

    expect(jobRuns.calls[0]).toEqual({
      method: 'countByPoolAndStatus',
      args: [undefined],
    });
    expect(syncRuns.calls[0]).toEqual({
      method: 'listRecent',
      args: [10, undefined, undefined],
    });
  });
});
