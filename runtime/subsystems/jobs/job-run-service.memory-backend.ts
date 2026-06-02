/**
 * MemoryJobRunService — scope-oriented queries and bulk ops over the
 * in-memory run store (ADR-022, JOB-4).
 *
 * Mirrors `DrizzleJobRunService` but scans `MemoryJobStore.runs.values()`.
 * Cancel delegates back to the orchestrator so cascade semantics stay in
 * one place.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { JobRunRow } from './job-orchestration.schema';
import type { JobRun } from './job-orchestrator.protocol';
import type {
  IJobRunService,
  ListForScopeOptions,
  CancelForScopeOptions,
  RescheduleForScopeOptions,
  PoolStatusCount,
  JobRunFailure,
  ListJobRunsQuery,
  JobRunPage,
} from './job-run-service.protocol';
import {
  clampLimit,
  decodeKeysetCursor,
  encodeKeysetCursor,
  toJobRunSummary,
} from './job-run-keyset-cursor';
import type { IJobOrchestrator } from './job-orchestrator.protocol';
import { JOB_ORCHESTRATOR, JOBS_MULTI_TENANT } from './jobs-domain.tokens';
import { MissingTenantIdError } from './jobs-errors';
import { MemoryJobStore } from './memory-job-store';

const NON_TERMINAL_STATUSES: JobRunRow['status'][] = [
  'pending',
  'running',
  'waiting',
];

@Injectable()
export class MemoryJobRunService implements IJobRunService {
  constructor(
    // ADR-037 (package-mode DI): explicit `@Inject(MemoryJobStore)` — the
    // published bundle carries no `design:paramtypes`, so a by-type inject
    // would resolve to `undefined` in package mode.
    @Inject(MemoryJobStore) private readonly store: MemoryJobStore,
    @Inject(JOB_ORCHESTRATOR) private readonly orchestrator: IJobOrchestrator,
    @Inject(JOBS_MULTI_TENANT) private readonly multiTenant: boolean,
  ) {}

  /**
   * JOB-8 — produce a per-row predicate for the tenant gate.
   * Returns `null` when multi-tenancy is off (caller doesn't check).
   * Throws when on + `undefined`; matches `tenant_id IS NULL` on explicit
   * `null` to support cross-tenant background work.
   */
  private tenantPredicate(
    method: string,
    tenantId: string | null | undefined,
  ): ((r: JobRunRow) => boolean) | null {
    if (!this.multiTenant) return null;
    if (tenantId === undefined) throw new MissingTenantIdError(method);
    return (r) => r.tenantId === tenantId;
  }

  async listForScope(
    entityType: string,
    entityId: string,
    opts: ListForScopeOptions = {},
  ): Promise<JobRun[]> {
    const statusFilter = opts.status
      ? Array.isArray(opts.status)
        ? new Set(opts.status)
        : new Set([opts.status])
      : null;
    const tenantCheck = this.tenantPredicate('listForScope', opts.tenantId);

    const rows: JobRunRow[] = [];
    for (const r of this.store.runs.values()) {
      if (r.scopeEntityType !== entityType) continue;
      if (r.scopeEntityId !== entityId) continue;
      if (statusFilter && !statusFilter.has(r.status)) continue;
      if (opts.jobType && r.jobType !== opts.jobType) continue;
      if (tenantCheck && !tenantCheck(r)) continue;
      rows.push(r);
    }

    const orderBy = opts.orderBy ?? 'created_at desc';
    rows.sort((a, b) => compareBy(a, b, orderBy));

    const offset = opts.offset ?? 0;
    const limit = opts.limit;
    const sliced =
      typeof limit === 'number' ? rows.slice(offset, offset + limit) : rows.slice(offset);
    return sliced as JobRun[];
  }

  async cancelForScope(
    entityType: string,
    entityId: string,
    opts: CancelForScopeOptions = {},
  ): Promise<void> {
    const tenantCheck = this.tenantPredicate('cancelForScope', opts.tenantId);

    const ids: string[] = [];
    for (const r of this.store.runs.values()) {
      if (r.scopeEntityType !== entityType) continue;
      if (r.scopeEntityId !== entityId) continue;
      if (!NON_TERMINAL_STATUSES.includes(r.status)) continue;
      if (tenantCheck && !tenantCheck(r)) continue;
      ids.push(r.id);
    }
    for (const id of ids) {
      // Propagate the tenant gate through the orchestrator's cancel so the
      // internal per-row guard passes (no surprise MissingTenantIdError
      // once the scope query has already narrowed to this tenant).
      await this.orchestrator.cancel(id, {
        cascade: true,
        tenantId: opts.tenantId,
      });
    }
  }

  async rescheduleForScope(
    entityType: string,
    entityId: string,
    newRunAt: Date,
    opts: RescheduleForScopeOptions = {},
  ): Promise<void> {
    const tenantCheck = this.tenantPredicate('rescheduleForScope', opts.tenantId);
    for (const r of this.store.runs.values()) {
      if (r.scopeEntityType !== entityType) continue;
      if (r.scopeEntityId !== entityId) continue;
      if (r.status !== 'pending') continue;
      if (tenantCheck && !tenantCheck(r)) continue;
      this.store.runs.set(r.id, {
        ...r,
        runAt: newRunAt,
        updatedAt: new Date(),
      });
    }
  }

  async countByPoolAndStatus(
    tenantId?: string | null,
  ): Promise<PoolStatusCount[]> {
    const tenantCheck = this.tenantPredicate('countByPoolAndStatus', tenantId);
    const map = new Map<string, PoolStatusCount>();
    for (const r of this.store.runs.values()) {
      if (tenantCheck && !tenantCheck(r)) continue;
      const key = `${r.pool}\0${r.status}`;
      const cur = map.get(key);
      if (cur) {
        cur.count += 1;
      } else {
        map.set(key, { pool: r.pool, status: r.status, count: 1 });
      }
    }
    return Array.from(map.values());
  }

  async listRecentFailed(
    limit: number,
    tenantId?: string | null,
  ): Promise<JobRunFailure[]> {
    const tenantCheck = this.tenantPredicate('listRecentFailed', tenantId);
    const failed: JobRunRow[] = [];
    for (const r of this.store.runs.values()) {
      if (r.status !== 'failed') continue;
      if (tenantCheck && !tenantCheck(r)) continue;
      failed.push(r);
    }
    failed.sort((a, b) => {
      const at = (a.finishedAt ?? a.updatedAt).getTime();
      const bt = (b.finishedAt ?? b.updatedAt).getTime();
      return bt - at;
    });
    return failed.slice(0, limit).map((r) => ({
      runId: r.id,
      jobType: r.jobType,
      pool: r.pool,
      scopeEntityType: r.scopeEntityType,
      scopeEntityId: r.scopeEntityId,
      tenantId: r.tenantId,
      attempts: r.attempts,
      errorMessage: r.error?.message ?? null,
      failedAt: r.finishedAt ?? r.updatedAt,
      createdAt: r.createdAt,
    }));
  }

  async listJobRuns(query: ListJobRunsQuery = {}): Promise<JobRunPage> {
    const limit = clampLimit(query.limit);
    const tenantCheck = this.tenantPredicate('listJobRuns', query.tenantId);
    const keyset = query.cursor ? decodeKeysetCursor(query.cursor) : null;

    const matched: JobRunRow[] = [];
    for (const r of this.store.runs.values()) {
      if (tenantCheck && !tenantCheck(r)) continue;
      if (query.poolId && r.pool !== query.poolId) continue;
      if (query.rootRunId && r.rootRunId !== query.rootRunId) continue;
      if (query.status && r.status !== query.status) continue;
      if (query.since && r.createdAt.getTime() < query.since.getTime()) continue;
      matched.push(r);
    }

    // Order created_at DESC, id DESC to match the Drizzle backend's keyset.
    matched.sort((a, b) => {
      const dt = b.createdAt.getTime() - a.createdAt.getTime();
      if (dt !== 0) return dt;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    // Keyset seek: drop everything at/after the cursor's (created_at, id).
    const seeked = keyset
      ? matched.filter((r) => {
          const ct = r.createdAt.getTime();
          const kt = keyset.createdAt.getTime();
          if (ct < kt) return true;
          if (ct > kt) return false;
          return r.id < keyset.id;
        })
      : matched;

    const hasMore = seeked.length > limit;
    const page = hasMore ? seeked.slice(0, limit) : seeked;
    const items = page.map(toJobRunSummary);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    return { items, nextCursor };
  }

  /**
   * Direct lookup. Not on the protocol — concrete-class convenience for
   * tests. Matches `DrizzleJobRunService.findByRootRunId` in spirit; both
   * are debug / test helpers that sidestep the orchestrator.
   */
  findById(runId: string): JobRun | null {
    return (this.store.runs.get(runId) ?? null) as JobRun | null;
  }

  /** Public counterpart to the Drizzle backend's `findByRootRunId` helper. */
  findByRootRunId(rootRunId: string): JobRun[] {
    const out: JobRunRow[] = [];
    for (const r of this.store.runs.values()) {
      if (r.rootRunId === rootRunId) out.push(r);
    }
    return out as JobRun[];
  }
}

function compareBy(
  a: JobRunRow,
  b: JobRunRow,
  order: Exclude<ListForScopeOptions['orderBy'], undefined>,
): number {
  switch (order) {
    case 'created_at asc':
      return a.createdAt.getTime() - b.createdAt.getTime();
    case 'run_at desc':
      return b.runAt.getTime() - a.runAt.getTime();
    case 'run_at asc':
      return a.runAt.getTime() - b.runAt.getTime();
    case 'created_at desc':
    default:
      return b.createdAt.getTime() - a.createdAt.getTime();
  }
}
