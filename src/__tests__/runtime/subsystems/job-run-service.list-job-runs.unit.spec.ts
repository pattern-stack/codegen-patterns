/**
 * OBS-LIST-1 — unit tests for `MemoryJobRunService.listJobRuns`.
 *
 * Covers the keyset-paginated, filterable run list that the observability
 * combiner composes:
 *   - Empty store
 *   - Ordering (created_at desc, id desc tie-break)
 *   - Filters: poolId, status, rootRunId, since
 *   - Keyset pagination round-trip (no overlap, no gaps)
 *   - limit clamp (default + max)
 *   - JobRunSummary projection (errorMessage from error.message)
 *   - Tenant gate matrix (off ignores; on + string/null/undefined)
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
  const id = overrides.id ?? `run-${String(seq).padStart(4, '0')}`;
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
    triggerSource: 'manual',
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

describe('MemoryJobRunService.listJobRuns — basics', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(false);
  });

  it('returns an empty page for an empty store', async () => {
    const page = await h.runService.listJobRuns();
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('orders by created_at desc', async () => {
    seedRun(h.store, { id: 'old', pool: 'p', status: 'pending', createdAt: new Date('2026-01-01T00:00:00Z') });
    seedRun(h.store, { id: 'new', pool: 'p', status: 'pending', createdAt: new Date('2026-01-03T00:00:00Z') });
    seedRun(h.store, { id: 'mid', pool: 'p', status: 'pending', createdAt: new Date('2026-01-02T00:00:00Z') });

    const page = await h.runService.listJobRuns();
    expect(page.items.map((r) => r.runId)).toEqual(['new', 'mid', 'old']);
    expect(page.nextCursor).toBeNull();
  });

  it('filters by poolId, status, and rootRunId', async () => {
    seedRun(h.store, { id: 'a', pool: 'batch', status: 'failed', rootRunId: 'root-1' });
    seedRun(h.store, { id: 'b', pool: 'batch', status: 'pending', rootRunId: 'root-1' });
    seedRun(h.store, { id: 'c', pool: 'api', status: 'failed', rootRunId: 'root-2' });

    expect((await h.runService.listJobRuns({ poolId: 'batch' })).items.map((r) => r.runId).sort()).toEqual(['a', 'b']);
    expect((await h.runService.listJobRuns({ status: 'failed' })).items.map((r) => r.runId).sort()).toEqual(['a', 'c']);
    expect((await h.runService.listJobRuns({ rootRunId: 'root-1' })).items.map((r) => r.runId).sort()).toEqual(['a', 'b']);
  });

  it('filters by since (inclusive lower bound on created_at)', async () => {
    seedRun(h.store, { id: 'before', pool: 'p', status: 'pending', createdAt: new Date('2026-01-01T00:00:00Z') });
    seedRun(h.store, { id: 'on', pool: 'p', status: 'pending', createdAt: new Date('2026-01-02T00:00:00Z') });
    seedRun(h.store, { id: 'after', pool: 'p', status: 'pending', createdAt: new Date('2026-01-03T00:00:00Z') });

    const page = await h.runService.listJobRuns({ since: new Date('2026-01-02T00:00:00Z') });
    expect(page.items.map((r) => r.runId).sort()).toEqual(['after', 'on']);
  });

  it('projects JobRunSummary with errorMessage from error.message', async () => {
    seedRun(h.store, {
      id: 'proj',
      pool: 'api',
      status: 'failed',
      rootRunId: 'r',
      scopeEntityType: 'account',
      scopeEntityId: 'acc-1',
      tenantId: 'T',
      attempts: 2,
      error: { message: 'boom', retryable: false, attempt: 2 },
      runAt: new Date('2026-01-04T00:00:00Z'),
      startedAt: new Date('2026-01-04T00:00:01Z'),
      finishedAt: new Date('2026-01-04T00:00:02Z'),
      createdAt: new Date('2026-01-04T00:00:00Z'),
    });
    const [row] = (await h.runService.listJobRuns()).items;
    expect(row).toEqual({
      runId: 'proj',
      rootRunId: 'r',
      jobType: 'test.job',
      pool: 'api',
      status: 'failed',
      scopeEntityType: 'account',
      scopeEntityId: 'acc-1',
      tenantId: 'T',
      attempts: 2,
      errorMessage: 'boom',
      runAt: new Date('2026-01-04T00:00:00Z'),
      startedAt: new Date('2026-01-04T00:00:01Z'),
      finishedAt: new Date('2026-01-04T00:00:02Z'),
      createdAt: new Date('2026-01-04T00:00:00Z'),
    });
  });
});

describe('MemoryJobRunService.listJobRuns — keyset pagination', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(false);
  });

  it('walks every row exactly once across pages with no overlap or gap', async () => {
    // 7 rows at distinct created_at; page through with limit 3.
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = `r-${i}`;
      ids.push(id);
      seedRun(h.store, { id, pool: 'p', status: 'pending', createdAt: new Date(Date.UTC(2026, 0, i + 1)) });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.runService.listJobRuns({ limit: 3, cursor });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((r) => r.runId));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    // Newest first, all 7, no duplicates.
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(7);
  });

  it('breaks ties on id desc when created_at is identical', async () => {
    const t = new Date('2026-02-01T00:00:00Z');
    seedRun(h.store, { id: 'aaa', pool: 'p', status: 'pending', createdAt: t });
    seedRun(h.store, { id: 'ccc', pool: 'p', status: 'pending', createdAt: t });
    seedRun(h.store, { id: 'bbb', pool: 'p', status: 'pending', createdAt: t });

    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.runService.listJobRuns({ limit: 1, cursor });
      all.push(...page.items.map((r) => r.runId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(all).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('clamps limit above the max', async () => {
    for (let i = 0; i < 3; i += 1) {
      seedRun(h.store, { id: `m-${i}`, pool: 'p', status: 'pending', createdAt: new Date(Date.UTC(2026, 2, i + 1)) });
    }
    // limit 10_000 clamps to MAX (200) — far above the 3 rows; one page.
    const page = await h.runService.listJobRuns({ limit: 10_000 });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('treats a malformed cursor as "from the beginning" (no throw)', async () => {
    seedRun(h.store, { id: 'x', pool: 'p', status: 'pending' });
    const page = await h.runService.listJobRuns({ cursor: 'not-a-real-cursor' });
    expect(page.items.map((r) => r.runId)).toEqual(['x']);
  });
});

describe('MemoryJobRunService.listJobRuns — multi-tenant', () => {
  it('off — tenantId ignored', async () => {
    const h = build(false);
    seedRun(h.store, { pool: 'p', status: 'pending', tenantId: 'A' });
    seedRun(h.store, { pool: 'p', status: 'pending', tenantId: 'B' });
    const page = await h.runService.listJobRuns({ tenantId: 'A' });
    expect(page.items).toHaveLength(2);
  });

  it('on + string filters to that tenant', async () => {
    const h = build(true);
    seedRun(h.store, { id: 'ta', pool: 'p', status: 'pending', tenantId: 'A' });
    seedRun(h.store, { id: 'tb', pool: 'p', status: 'pending', tenantId: 'B' });
    const page = await h.runService.listJobRuns({ tenantId: 'A' });
    expect(page.items.map((r) => r.runId)).toEqual(['ta']);
  });

  it('on + null matches tenant_id IS NULL', async () => {
    const h = build(true);
    seedRun(h.store, { id: 'tn', pool: 'p', status: 'pending', tenantId: null });
    seedRun(h.store, { id: 'ta', pool: 'p', status: 'pending', tenantId: 'A' });
    const page = await h.runService.listJobRuns({ tenantId: null });
    expect(page.items.map((r) => r.runId)).toEqual(['tn']);
  });

  it('on + undefined throws MissingTenantIdError', async () => {
    const h = build(true);
    await expect(h.runService.listJobRuns()).rejects.toBeInstanceOf(MissingTenantIdError);
  });
});
