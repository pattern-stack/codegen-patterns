# OBS-2: Extend `IJobRunService` with observability reads — Spec

**Issue:** #204 (OBS-2)
**Status:** Draft
**Last Updated:** 2026-04-23

## Overview

Add two read methods to `IJobRunService` that observability callers need: `countByPoolAndStatus(tenantId?)` for pool-depth dashboards and `listRecentFailed(limit, tenantId?)` for a "recent failures" widget. Both methods land in the existing protocol file plus both backends (Drizzle + Memory), delegate tenant filtering to the already-established `tenantCondition()` / `tenantPredicate()` helpers, and ship with unit (memory) + integration (Drizzle) tests. No new consumers — this is a core-contract extension that OBS-5 will compose.

## Architecture

```
IJobRunService (protocol)
    ├── listForScope(), cancelForScope(), rescheduleForScope()   [existing]
    ├── countByPoolAndStatus(tenantId?)                          [NEW]
    └── listRecentFailed(limit, tenantId?)                       [NEW]

DrizzleJobRunService  implements IJobRunService
    └── uses DRIZZLE + tenantCondition() [existing helper]

MemoryJobRunService   implements IJobRunService
    └── uses MemoryJobStore.runs + tenantPredicate() [existing helper]
```

## Files

| File | Action | Purpose |
|---|---|---|
| `runtime/subsystems/jobs/job-run-service.protocol.ts` | modify | Add `PoolStatusCount`, `JobRunFailure` types; add 2 method signatures to `IJobRunService` |
| `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts` | modify | Implement both methods using Drizzle `GROUP BY` + `ORDER BY LIMIT` |
| `runtime/subsystems/jobs/job-run-service.memory-backend.ts` | modify | Implement both methods by scanning `MemoryJobStore.runs.values()` |
| `runtime/subsystems/jobs/index.ts` | modify *(if a barrel exists)* | Re-export `PoolStatusCount`, `JobRunFailure` |
| `src/__tests__/<path>/job-run-service.memory.test.ts` | create or modify | Unit tests for `MemoryJobRunService` new methods |
| `test/integration/<path>/job-run-service.drizzle.test.ts` | create or modify | Integration tests for `DrizzleJobRunService` new methods against Postgres |

## Interfaces

Add to `job-run-service.protocol.ts`:

```typescript
import type { JobRun } from './job-orchestrator.protocol';

/**
 * One row per (pool, status) combination currently present in `job_run`.
 * Used by observability to render pool-depth dashboards.
 */
export interface PoolStatusCount {
  pool: string;
  status: JobRun['status'];
  count: number;
}

/**
 * Summary row for the "recent failed runs" observability widget. A narrow
 * projection over `JobRun` — just the fields a dashboard needs.
 */
export interface JobRunFailure {
  runId: string;
  jobType: string;
  pool: string;
  scopeEntityType: string | null;
  scopeEntityId: string | null;
  tenantId: string | null;
  attempts: number;
  errorMessage: string | null;
  failedAt: Date;
  createdAt: Date;
}

export interface IJobRunService {
  // ... existing methods unchanged ...

  /**
   * Aggregate live counts of `job_run` rows grouped by `(pool, status)`.
   * Tenant gate follows the same rules as `listForScope`:
   *   - multiTenant off → parameter ignored.
   *   - multiTenant on + string → filters `tenant_id = :tenantId`.
   *   - multiTenant on + null   → filters `tenant_id IS NULL`.
   *   - multiTenant on + undefined → throws `MissingTenantIdError`.
   */
  countByPoolAndStatus(tenantId?: string | null): Promise<PoolStatusCount[]>;

  /**
   * Most-recent `failed` runs, newest first. `limit` is required.
   * Tenant gate follows `countByPoolAndStatus`.
   */
  listRecentFailed(
    limit: number,
    tenantId?: string | null,
  ): Promise<JobRunFailure[]>;
}
```

## Implementation Steps

### 1. Extend the protocol

- Add `PoolStatusCount` and `JobRunFailure` exported interfaces
- Add the two new method signatures to `IJobRunService`
- Do not reorder existing members

### 2. Implement in the Drizzle backend

```typescript
async countByPoolAndStatus(tenantId?: string | null): Promise<PoolStatusCount[]> {
  const tenantCond = this.tenantCondition('countByPoolAndStatus', tenantId);
  const rows = await this.db
    .select({
      pool: jobRuns.pool,
      status: jobRuns.status,
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(jobRuns)
    .where(tenantCond ?? undefined)
    .groupBy(jobRuns.pool, jobRuns.status);

  return rows.map((r) => ({
    pool: r.pool,
    status: r.status,
    count: Number(r.count),
  }));
}

async listRecentFailed(limit: number, tenantId?: string | null): Promise<JobRunFailure[]> {
  const conditions = [eq(jobRuns.status, 'failed' as const)];
  const tenantCond = this.tenantCondition('listRecentFailed', tenantId);
  if (tenantCond) conditions.push(tenantCond);

  const rows = await this.db
    .select()
    .from(jobRuns)
    .where(and(...conditions))
    .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
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
```

Cast `count(*)::int` to avoid drizzle returning a bigint string.

### 3. Implement in the Memory backend

```typescript
async countByPoolAndStatus(tenantId?: string | null): Promise<PoolStatusCount[]> {
  const tenantCheck = this.tenantPredicate('countByPoolAndStatus', tenantId);
  const map = new Map<string, PoolStatusCount>();
  for (const r of this.store.runs.values()) {
    if (tenantCheck && !tenantCheck(r)) continue;
    const key = `${r.pool}\0${r.status}`;
    const cur = map.get(key);
    if (cur) { cur.count += 1; }
    else { map.set(key, { pool: r.pool, status: r.status, count: 1 }); }
  }
  return Array.from(map.values());
}

async listRecentFailed(limit: number, tenantId?: string | null): Promise<JobRunFailure[]> {
  const tenantCheck = this.tenantPredicate('listRecentFailed', tenantId);
  const failed: JobRunRow[] = [];
  for (const r of this.store.runs.values()) {
    if (r.status !== 'failed') continue;
    if (tenantCheck && !tenantCheck(r)) continue;
    failed.push(r);
  }
  failed.sort((a, b) => (b.finishedAt ?? b.updatedAt).getTime() - (a.finishedAt ?? a.updatedAt).getTime());
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
```

### 4. Unit tests (memory backend)

Tests for `countByPoolAndStatus`:
- Empty store returns `[]`
- Mixed pools/statuses produce one entry per `(pool, status)` pair with correct count
- `multiTenant: false` + `tenantId` argument is ignored
- `multiTenant: true` + `tenantId: 'A'` returns only rows where `tenantId === 'A'`
- `multiTenant: true` + `tenantId: null` returns only rows where `tenantId === null`
- `multiTenant: true` + `tenantId: undefined` throws `MissingTenantIdError`

Tests for `listRecentFailed`:
- Non-failed rows excluded
- Ordering by `finishedAt` desc, `updatedAt` desc as tie-break
- Rows with null `finishedAt` fall back to `updatedAt`
- `limit` truncates
- `errorMessage` pulls from `error.message`; null when `error` is null
- Same tenant-gate matrix as above

### 5. Integration tests (Drizzle backend)

Reuse the docker-backed Postgres harness. Same test matrix as memory, plus:
- `count(*)` comes back as `number` (regression guard for `::int` cast)
- `error` jsonb round-trips correctly in `errorMessage`

## Testing Strategy

- **Unit (memory)**: fast, no Docker — covers tenant gate matrix
- **Integration (Drizzle)**: runs via `just test-family` — verifies SQL correctness
- **No baseline impact**: additions are in `runtime/`, not templates

## Open Questions

- [ ] Exact test file paths — inspect `src/__tests__/` and `test/` for existing `MemoryJobRunService` / `DrizzleJobRunService` tests and extend; create only if none exist
- [ ] `failedAt` fallback — confirm Drizzle backend sets `finishedAt` consistently on `failed` transition. If yes, drop the `updatedAt` fallback. If not, keep.
- [ ] Barrel export — add `PoolStatusCount`, `JobRunFailure` to `runtime/subsystems/jobs/index.ts` if the barrel re-exports types

## References

- Decisions: `.claude/specs/epic-195-architecture-decisions.md` §4, §5
- Plan: `.claude/specs/epic-195-plan.md` OBS-2
- Existing port: `runtime/subsystems/jobs/job-run-service.protocol.ts`
- Drizzle impl + `tenantCondition()`: `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts`
- Memory impl + `tenantPredicate()`: `runtime/subsystems/jobs/job-run-service.memory-backend.ts`
- Schema: `runtime/subsystems/jobs/job-orchestration.schema.ts`
