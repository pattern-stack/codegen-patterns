/**
 * MemoryObservabilityService — in-memory test backend for
 * IObservabilityService.
 *
 * Stores snapshot data set by the test harness and returns it verbatim.
 * This is deliberately NOT a replay-from-events simulator — the point of
 * the memory backend is to let tests assert "when the subsystem returns
 * X, does the caller render Y correctly?" without standing up Postgres.
 *
 * Tests populate the backend via the `seed*` methods, then exercise the
 * protocol reads. Each seed method replaces (not merges) its slice, which
 * keeps the mental model simple: the backend is a fixture holder.
 *
 * No lifecycle hooks (no background work to manage).
 */
import { Injectable } from '@nestjs/common';
import type {
  CursorSnapshot,
  IObservabilityService,
  JobRunFailure,
  PoolDepth,
  StatusHistogram,
  SyncRunSummary,
} from './observability.protocol';

@Injectable()
export class MemoryObservabilityService implements IObservabilityService {
  private pools: PoolDepth[] = [];
  private syncRuns: SyncRunSummary[] = [];
  private bridgeHistogram: StatusHistogram = {};
  private failedJobs: JobRunFailure[] = [];
  private cursors: CursorSnapshot[] = [];

  // ─── Core contract ─────────────────────────────────────────────────────

  async getPoolDepths(): Promise<PoolDepth[]> {
    return [...this.pools];
  }

  async getRecentSyncRuns(
    limit: number,
    integrationId?: string,
  ): Promise<SyncRunSummary[]> {
    const filtered =
      integrationId !== undefined
        ? this.syncRuns.filter((r) => r.integrationId === integrationId)
        : this.syncRuns;
    return filtered
      .slice()
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async getBridgeDeliveryHistogram(
    _windowHours: number,
  ): Promise<StatusHistogram> {
    // Memory backend ignores the window — tests that care about windowing
    // should seed the histogram for the window they're simulating.
    return { ...this.bridgeHistogram };
  }

  async getRecentFailedJobs(limit: number): Promise<JobRunFailure[]> {
    return this.failedJobs
      .slice()
      .sort(
        (a, b) =>
          (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0),
      )
      .slice(0, limit);
  }

  async getCursors(): Promise<CursorSnapshot[]> {
    return [...this.cursors];
  }

  // ─── Test seams ────────────────────────────────────────────────────────

  /** Replace the pool-depth slice. */
  seedPools(pools: PoolDepth[]): void {
    this.pools = [...pools];
  }

  /** Replace the sync-run slice. */
  seedSyncRuns(runs: SyncRunSummary[]): void {
    this.syncRuns = [...runs];
  }

  /** Replace the bridge-delivery histogram. */
  seedBridgeHistogram(hist: StatusHistogram): void {
    this.bridgeHistogram = { ...hist };
  }

  /** Replace the failed-jobs slice. */
  seedFailedJobs(jobs: JobRunFailure[]): void {
    this.failedJobs = [...jobs];
  }

  /** Replace the cursor slice. */
  seedCursors(cursors: CursorSnapshot[]): void {
    this.cursors = [...cursors];
  }

  /** Reset every slice — for afterEach hooks. */
  reset(): void {
    this.pools = [];
    this.syncRuns = [];
    this.bridgeHistogram = {};
    this.failedJobs = [];
    this.cursors = [];
  }
}
