/**
 * DrizzleObservabilityService — production backend for IObservabilityService.
 *
 * Pure read-only SQL over framework-owned tables:
 *   - `job_run`            (jobs subsystem)
 *   - `bridge_delivery`    (bridge subsystem)
 *   - `domain_events`      (events subsystem)
 *   - `sync_runs`          (sync subsystem)
 *   - `sync_subscriptions` (sync subsystem)
 *
 * No new tables, no background loops, no lifecycle hooks. This is a query
 * facade — each call hits the DB and returns. Rate-limit / dashboard-cadence
 * coordination is the caller's responsibility.
 *
 * # Error behavior
 *
 * Methods throw on DB failure (consistent with the rest of the ADR-008
 * family's write-ish backends). Dashboards and `/dev/status` endpoints are
 * expected to handle the error surface — returning an empty snapshot on a
 * transient DB blip would silently hide "Postgres is down" from operators,
 * which is the opposite of what observability is for.
 *
 * # Drizzle-specific extensions (documented per CLAUDE.md core/extensions)
 *
 * Extensions MAY be added to this class that leverage Postgres-specific
 * capability (e.g. `pg_stat_activity` sampling, advisory-lock inspection).
 * Consumers opting into extensions accept backend-specific coupling; the
 * core five methods below stay backend-portable.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';

import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';
import { bridgeDelivery } from '../bridge/bridge-delivery.schema';
import { jobRuns } from '../jobs/job-orchestration.schema';
import { syncRuns, syncSubscriptions } from '../sync/sync-audit.schema';
import type {
  CursorSnapshot,
  IObservabilityService,
  JobRunFailure,
  PoolDepth,
  StatusHistogram,
  SyncRunSummary,
} from './observability.protocol';

@Injectable()
export class DrizzleObservabilityService implements IObservabilityService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleClient) {}

  async getPoolDepths(): Promise<PoolDepth[]> {
    // Raw SQL: Drizzle's builder drops AS-aliases on bare `sql<>` columns,
    // which the pg driver then can't map back by name. Raw execute with
    // explicit aliases keeps the result shape deterministic.
    const result = await this.db.execute(sql`
      SELECT
        pool AS name,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        (percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (now() - claimed_at)) * 1000
        ) FILTER (WHERE status = 'running' AND claimed_at IS NOT NULL))::int
          AS claimed_age_p95_ms
      FROM job_run
      WHERE status IN ('pending','running')
      GROUP BY pool
      ORDER BY pool
    `);

    const rows = extractRows<{
      name: string;
      pending: number;
      running: number;
      claimed_age_p95_ms: number | null;
    }>(result);

    return rows.map((r) => ({
      name: r.name,
      pending: r.pending,
      running: r.running,
      claimedAgeP95Ms: r.claimed_age_p95_ms,
    }));
  }

  async getRecentSyncRuns(
    limit: number,
    integrationId?: string,
  ): Promise<SyncRunSummary[]> {
    // Join to sync_subscriptions to recover integration/adapter/domain so
    // callers don't re-hydrate the subscription row themselves. Upstream
    // sync_runs owns only subscription_id; the enrichment columns live on
    // the subscription side.
    const base = this.db
      .select({
        id: syncRuns.id,
        subscriptionId: syncRuns.subscriptionId,
        integrationId: syncSubscriptions.integrationId,
        adapter: syncSubscriptions.adapter,
        domain: syncSubscriptions.domain,
        direction: syncRuns.direction,
        action: syncRuns.action,
        status: syncRuns.status,
        recordsFound: syncRuns.recordsFound,
        recordsProcessed: syncRuns.recordsProcessed,
        durationMs: syncRuns.durationMs,
        error: syncRuns.error,
        startedAt: syncRuns.startedAt,
        completedAt: syncRuns.completedAt,
      })
      .from(syncRuns)
      .innerJoin(
        syncSubscriptions,
        eq(syncRuns.subscriptionId, syncSubscriptions.id),
      );

    const filtered =
      integrationId !== undefined
        ? base.where(eq(syncSubscriptions.integrationId, integrationId))
        : base;

    const rows = await filtered.orderBy(desc(syncRuns.startedAt)).limit(limit);

    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscriptionId,
      integrationId: r.integrationId,
      adapter: r.adapter,
      domain: r.domain,
      direction: r.direction,
      action: r.action,
      status: r.status,
      recordsFound: r.recordsFound,
      recordsProcessed: r.recordsProcessed,
      durationMs: r.durationMs,
      error: r.error,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  }

  async getBridgeDeliveryHistogram(
    windowHours: number,
  ): Promise<StatusHistogram> {
    // Window on COALESCE(delivered_at, attempted_at) so terminal skipped/
    // failed rows (which never get delivered_at) are counted alongside
    // delivered rows. The histogram is a flat Record<status, count>.
    const result = await this.db.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM bridge_delivery
      WHERE COALESCE(delivered_at, attempted_at) > now() - make_interval(hours => ${windowHours})
      GROUP BY status
    `);

    const rows = extractRows<{ status: string; count: number }>(result);
    const hist: StatusHistogram = {};
    for (const r of rows) hist[r.status] = r.count;
    return hist;
  }

  async getRecentFailedJobs(limit: number): Promise<JobRunFailure[]> {
    const rows = await this.db
      .select({
        id: jobRuns.id,
        jobType: jobRuns.jobType,
        pool: jobRuns.pool,
        status: jobRuns.status,
        error: jobRuns.error,
        startedAt: jobRuns.startedAt,
        finishedAt: jobRuns.finishedAt,
        attempts: jobRuns.attempts,
      })
      .from(jobRuns)
      .where(eq(jobRuns.status, 'failed'))
      .orderBy(desc(jobRuns.finishedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      jobType: r.jobType,
      pool: r.pool,
      status: r.status,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      attempts: r.attempts,
    }));
  }

  async getCursors(): Promise<CursorSnapshot[]> {
    const rows = await this.db
      .select({
        id: syncSubscriptions.id,
        integrationId: syncSubscriptions.integrationId,
        adapter: syncSubscriptions.adapter,
        domain: syncSubscriptions.domain,
        cursor: syncSubscriptions.cursor,
        lastSyncAt: syncSubscriptions.lastSyncAt,
      })
      .from(syncSubscriptions)
      .where(eq(syncSubscriptions.enabled, true))
      .orderBy(syncSubscriptions.integrationId, syncSubscriptions.domain);

    return rows.map((r) => ({
      subscriptionId: r.id,
      integrationId: r.integrationId,
      adapter: r.adapter,
      domain: r.domain,
      lastCursor: r.cursor,
      lastSyncAt: r.lastSyncAt,
    }));
  }
}

/**
 * Normalize `db.execute()` return shape. `node-postgres` returns `{ rows: [] }`
 * while some pg-compatible drivers return the row array directly.
 */
function extractRows<T>(result: unknown): T[] {
  const maybe = result as { rows?: unknown };
  if (Array.isArray(maybe.rows)) return maybe.rows as T[];
  if (Array.isArray(result)) return result as T[];
  return [];
}
