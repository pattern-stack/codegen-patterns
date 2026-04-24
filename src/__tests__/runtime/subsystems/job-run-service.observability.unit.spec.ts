/**
 * OBS-2 — unit tests for `MemoryJobRunService.countByPoolAndStatus` and
 * `listRecentFailed`.
 *
 * Seeds `MemoryJobStore.runs` directly with partial `JobRunRow` shapes so
 * tests exercise the read paths without routing through the orchestrator
 * (keeps failure / timestamp / tenant fixtures trivial).
 *
 * Covers:
 *   - Empty store
 *   - Aggregation across pools and statuses
 *   - Non-failed rows excluded from `listRecentFailed`
 *   - Ordering by `finishedAt` desc with `updatedAt` tie-break
 *   - `finishedAt` null falls back to `updatedAt`
 *   - `limit` truncation
 *   - `errorMessage` extracted from `error.message`; null when `error` is null
 *   - Tenant-gate matrix mirroring `multi-tenant.unit.spec.ts`:
 *     multiTenant off ignores tenantId; on + string filters; on + null
 *     matches tenant_id IS NULL; on + undefined throws.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { JobRunRow } from '../../../../runtime/subsystems/jobs/job-orchestration.schema';
import { MemoryJobStore } from '../../../../runtime/subsystems/jobs/memory-job-store';
import { MemoryJobOrchestrator } from '../../../../runtime/subsystems/jobs/job-orchestrator.memory-backend';
import { MemoryJobRunService } from '../../../../runtime/subsystems/jobs/job-run-service.memory-backend';
import { MemoryJobStepService } from '../../../../runtime/subsystems/jobs/job-step-service.memory-backend';
import { MissingTenantIdError } from '../../../../runtime/subsystems/jobs/jobs-errors';

interface Harness {
  store: MemoryJobStore;
  runService: MemoryJobRunService;
}

function build(multiTenant: boolean): Harness {
  const store = new MemoryJobStore();
  const stepService = new MemoryJobStepService(store);
  const orchestrator = new MemoryJobOrchestrator(store, stepService, multiTenant);
  const runService = new MemoryJobRunService(store, orchestrator, multiTenant);
  return { store, runService };
}

let seq = 0;
function seedRun(
  store: MemoryJobStore,
  overrides: Partial<JobRunRow> & Pick<JobRunRow, 'status' | 'pool'>,
): JobRunRow {
  seq += 1;
  const id = overrides.id ?? `run-${seq}`;
  const now = new Date('2026-01-01T00:00:00Z');
  const row: JobRunRow = {
    id,
    jobType: 'test.job',
    jobVersion: 1,
    parentRunId: null,
    rootRunId: id,
    parentClosePolicy: 'terminate',
    scopeEntityType: null,
    scopeEntityId: null,
    tenantId: null,
    tags: {},
    pool: overrides.pool,
    priority: 0,
    concurrencyKey: null,
    dedupeKey: null,
    status: overrides.status,
    input: {},
    output: null,
    error: null,
    triggerSource: 'api',
    triggerRef: null,
    runAt: now,
    startedAt: null,
    finishedAt: null,
    claimedAt: null,
    attempts: 0,
    waitKind: null,
    resumeToken: null,
    waitDeadline: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  store.runs.set(row.id, row);
  return row;
}

// ─── countByPoolAndStatus ──────────────────────────────────────────────────

describe('MemoryJobRunService.countByPoolAndStatus', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(false);
  });

  it('returns [] for an empty store', async () => {
    const rows = await h.runService.countByPoolAndStatus();
    expect(rows).toEqual([]);
  });

  it('aggregates across pools and statuses', async () => {
    seedRun(h.store, { pool: 'batch', status: 'pending' });
    seedRun(h.store, { pool: 'batch', status: 'pending' });
    seedRun(h.store, { pool: 'batch', status: 'failed' });
    seedRun(h.store, { pool: 'api', status: 'pending' });

    const rows = await h.runService.countByPoolAndStatus();
    const byKey = new Map(rows.map((r) => [`${r.pool}/${r.status}`, r.count]));
    expect(byKey.get('batch/pending')).toBe(2);
    expect(byKey.get('batch/failed')).toBe(1);
    expect(byKey.get('api/pending')).toBe(1);
    expect(rows).toHaveLength(3);
  });

  it('multiTenant off — tenantId is ignored', async () => {
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: 'A' });
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: 'B' });

    const rows = await h.runService.countByPoolAndStatus('A');
    const entry = rows.find((r) => r.pool === 'batch' && r.status === 'pending');
    expect(entry?.count).toBe(2);
  });
});

describe('MemoryJobRunService.countByPoolAndStatus — multi-tenant ON', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(true);
  });

  it('tenantId: "A" returns only tenant A rows', async () => {
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: 'A' });
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: 'A' });
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: 'B' });

    const rows = await h.runService.countByPoolAndStatus('A');
    expect(rows).toEqual([{ pool: 'batch', status: 'pending', count: 2 }]);
  });

  it('tenantId: null returns only tenant_id NULL rows', async () => {
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: 'A' });
    seedRun(h.store, { pool: 'batch', status: 'pending', tenantId: null });

    const rows = await h.runService.countByPoolAndStatus(null);
    expect(rows).toEqual([{ pool: 'batch', status: 'pending', count: 1 }]);
  });

  it('tenantId: undefined throws MissingTenantIdError', async () => {
    await expect(h.runService.countByPoolAndStatus()).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
  });
});

// ─── listRecentFailed ──────────────────────────────────────────────────────

describe('MemoryJobRunService.listRecentFailed', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(false);
  });

  it('excludes non-failed rows', async () => {
    seedRun(h.store, { pool: 'batch', status: 'pending' });
    seedRun(h.store, { pool: 'batch', status: 'completed' });
    seedRun(h.store, { pool: 'batch', status: 'canceled' });
    const rows = await h.runService.listRecentFailed(10);
    expect(rows).toEqual([]);
  });

  it('orders by finishedAt desc, then updatedAt desc', async () => {
    seedRun(h.store, {
      id: 'old',
      pool: 'batch',
      status: 'failed',
      finishedAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    seedRun(h.store, {
      id: 'new',
      pool: 'batch',
      status: 'failed',
      finishedAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });
    seedRun(h.store, {
      id: 'mid',
      pool: 'batch',
      status: 'failed',
      finishedAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const rows = await h.runService.listRecentFailed(10);
    expect(rows.map((r) => r.runId)).toEqual(['new', 'mid', 'old']);
  });

  it('falls back to updatedAt when finishedAt is null', async () => {
    seedRun(h.store, {
      id: 'has-finished',
      pool: 'batch',
      status: 'failed',
      finishedAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    seedRun(h.store, {
      id: 'no-finished',
      pool: 'batch',
      status: 'failed',
      finishedAt: null,
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });

    const rows = await h.runService.listRecentFailed(10);
    expect(rows.map((r) => r.runId)).toEqual(['no-finished', 'has-finished']);
    expect(rows[0]!.failedAt).toEqual(new Date('2026-01-03T00:00:00Z'));
  });

  it('limit truncates', async () => {
    for (let i = 0; i < 5; i += 1) {
      seedRun(h.store, {
        id: `r-${i}`,
        pool: 'batch',
        status: 'failed',
        finishedAt: new Date(Date.UTC(2026, 0, i + 1)),
        updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }
    const rows = await h.runService.listRecentFailed(2);
    expect(rows).toHaveLength(2);
  });

  it('errorMessage pulls from error.message; null when error is null', async () => {
    seedRun(h.store, {
      id: 'with-error',
      pool: 'batch',
      status: 'failed',
      error: { message: 'boom', retryable: false, attempt: 1 },
      finishedAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    seedRun(h.store, {
      id: 'no-error',
      pool: 'batch',
      status: 'failed',
      error: null,
      finishedAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const rows = await h.runService.listRecentFailed(10);
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get('with-error')?.errorMessage).toBe('boom');
    expect(byId.get('no-error')?.errorMessage).toBeNull();
  });

  it('multiTenant off — tenantId is ignored', async () => {
    seedRun(h.store, { pool: 'batch', status: 'failed', tenantId: 'A' });
    seedRun(h.store, { pool: 'batch', status: 'failed', tenantId: 'B' });
    const rows = await h.runService.listRecentFailed(10, 'A');
    expect(rows).toHaveLength(2);
  });

  it('projects scope and tenant fields onto JobRunFailure', async () => {
    seedRun(h.store, {
      id: 'proj',
      pool: 'api',
      status: 'failed',
      scopeEntityType: 'account',
      scopeEntityId: 'acc-1',
      tenantId: 'T',
      attempts: 3,
      error: { message: 'x', retryable: true, attempt: 3 },
      finishedAt: new Date('2026-01-05T00:00:00Z'),
      updatedAt: new Date('2026-01-05T00:00:00Z'),
      createdAt: new Date('2026-01-04T00:00:00Z'),
    });
    const [row] = await h.runService.listRecentFailed(1);
    expect(row).toEqual({
      runId: 'proj',
      jobType: 'test.job',
      pool: 'api',
      scopeEntityType: 'account',
      scopeEntityId: 'acc-1',
      tenantId: 'T',
      attempts: 3,
      errorMessage: 'x',
      failedAt: new Date('2026-01-05T00:00:00Z'),
      createdAt: new Date('2026-01-04T00:00:00Z'),
    });
  });
});

describe('MemoryJobRunService.listRecentFailed — multi-tenant ON', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(true);
  });

  it('tenantId: "A" returns only A-owned failed runs', async () => {
    seedRun(h.store, {
      id: 'a',
      pool: 'batch',
      status: 'failed',
      tenantId: 'A',
      finishedAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    seedRun(h.store, {
      id: 'b',
      pool: 'batch',
      status: 'failed',
      tenantId: 'B',
      finishedAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });
    const rows = await h.runService.listRecentFailed(10, 'A');
    expect(rows.map((r) => r.runId)).toEqual(['a']);
  });

  it('tenantId: null returns only tenant_id NULL failed runs', async () => {
    seedRun(h.store, {
      id: 'null-tenant',
      pool: 'batch',
      status: 'failed',
      tenantId: null,
      finishedAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    seedRun(h.store, {
      id: 'a',
      pool: 'batch',
      status: 'failed',
      tenantId: 'A',
      finishedAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });
    const rows = await h.runService.listRecentFailed(10, null);
    expect(rows.map((r) => r.runId)).toEqual(['null-tenant']);
  });

  it('tenantId: undefined throws MissingTenantIdError', async () => {
    await expect(h.runService.listRecentFailed(10)).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
  });
});
