/**
 * Multi-tenancy unit tests (JOB-8).
 *
 * Covers every acceptance criterion from `docs/specs/JOB-8.md` against the
 * memory backend — no Docker, no DB. The Drizzle backend mirrors the same
 * enforcement logic via `resolveTenantId` / `tenantCondition`; integration
 * parity is a `just test-family` concern.
 *
 * Test matrix:
 *   - Flag false: `tenantId` is silently ignored; `tenant_id` always null;
 *     `listForScope` never filters by tenant.
 *   - Flag true, correct tenant: writes + reads pass the gate.
 *   - Flag true, wrong tenant on list: returns empty.
 *   - Flag true, wrong tenant on cancel: no-op (run stays non-terminal).
 *   - Flag true, missing tenantId (`undefined`): throws `MissingTenantIdError`.
 *   - Flag true, explicit `null`: passes; row persisted with `tenant_id: null`.
 *
 * Tests construct the services directly so each scenario owns its own store.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  JobHandlerBase,
  type JobContext,
} from '../../../../runtime/subsystems/jobs/job-handler.base';
import { MemoryJobStore } from '../../../../runtime/subsystems/jobs/memory-job-store';
import { MemoryJobOrchestrator } from '../../../../runtime/subsystems/jobs/job-orchestrator.memory-backend';
import { MemoryJobRunService } from '../../../../runtime/subsystems/jobs/job-run-service.memory-backend';
import { MemoryJobStepService } from '../../../../runtime/subsystems/jobs/job-step-service.memory-backend';
import { MissingTenantIdError } from '../../../../runtime/subsystems/jobs/jobs-errors';

class NoopHandler extends JobHandlerBase<Record<string, unknown>, unknown> {
  async run(_ctx: JobContext<Record<string, unknown>>): Promise<unknown> {
    return {};
  }
}

interface Harness {
  store: MemoryJobStore;
  stepService: MemoryJobStepService;
  orchestrator: MemoryJobOrchestrator;
  runService: MemoryJobRunService;
}

function build(multiTenant: boolean): Harness {
  const store = new MemoryJobStore();
  const stepService = new MemoryJobStepService(store);
  const orchestrator = new MemoryJobOrchestrator(store, stepService, multiTenant);
  const runService = new MemoryJobRunService(store, orchestrator, multiTenant);
  orchestrator.registerHandler('t.mt', { pool: 'batch' }, NoopHandler);
  return { store, stepService, orchestrator, runService };
}

// ─── Flag FALSE (baseline parity with pre-JOB-8 behaviour) ──────────────────

describe('multi-tenant OFF — baseline behaviour preserved', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(false);
  });

  it('start() writes tenant_id: null even if tenantId is passed', async () => {
    const run = await h.orchestrator.start('t.mt', {}, { tenantId: 'A' });
    const persisted = h.store.runs.get(run.id);
    expect(persisted?.tenantId).toBeNull();
  });

  it('listForScope ignores opts.tenantId entirely', async () => {
    const a = await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: 'A' },
    );
    const b = await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: 'B' },
    );

    // Filtering by 'A' must still return both — the flag is off.
    const rowsA = await h.runService.listForScope('acct', '1', { tenantId: 'A' });
    expect(rowsA.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    // And filtering by 'Z' still returns both.
    const rowsZ = await h.runService.listForScope('acct', '1', { tenantId: 'Z' });
    expect(rowsZ.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('start() without tenantId does NOT throw when flag is off', async () => {
    // Regression guard — the strict-throw path must be gated on the flag.
    await expect(h.orchestrator.start('t.mt', {})).resolves.toBeDefined();
  });
});

// ─── Flag TRUE — correct tenant / tenant isolation ──────────────────────────

describe('multi-tenant ON — tenant isolation', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(true);
  });

  it('start({ tenantId: "A" }) persists tenant_id="A"', async () => {
    const run = await h.orchestrator.start('t.mt', {}, { tenantId: 'A' });
    expect(h.store.runs.get(run.id)?.tenantId).toBe('A');
  });

  it('listForScope({ tenantId: "A" }) returns only A-owned rows', async () => {
    const runA = await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: 'A' },
    );
    await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: 'B' },
    );

    const rows = await h.runService.listForScope('acct', '1', { tenantId: 'A' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(runA.id);
  });

  it('listForScope({ tenantId: "B" }) returns empty when no B rows match', async () => {
    await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: 'A' },
    );

    const rows = await h.runService.listForScope('acct', '1', { tenantId: 'B' });
    expect(rows).toHaveLength(0);
  });

  it('cross-tenant cancel is a silent no-op (run stays non-terminal)', async () => {
    const runA = await h.orchestrator.start('t.mt', {}, { tenantId: 'A' });

    // B tries to cancel A's run.
    await h.orchestrator.cancel(runA.id, { tenantId: 'B' });

    const persisted = h.store.runs.get(runA.id);
    // Unchanged — A's run is still pending, not canceled.
    expect(persisted?.status).toBe('pending');
  });

  it('same-tenant cancel works as before', async () => {
    const runA = await h.orchestrator.start('t.mt', {}, { tenantId: 'A' });
    await h.orchestrator.cancel(runA.id, { tenantId: 'A' });
    expect(h.store.runs.get(runA.id)?.status).toBe('canceled');
  });
});

// ─── Flag TRUE — strict enforcement (undefined throws) ──────────────────────

describe('multi-tenant ON — strict enforcement of undefined tenantId', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(true);
  });

  it('start() without tenantId throws MissingTenantIdError', async () => {
    await expect(h.orchestrator.start('t.mt', {})).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
  });

  it('start({ tenantId: undefined }) explicitly also throws', async () => {
    await expect(
      h.orchestrator.start('t.mt', {}, { tenantId: undefined }),
    ).rejects.toBeInstanceOf(MissingTenantIdError);
  });

  it('cancel() without tenantId throws MissingTenantIdError', async () => {
    // Seed a row out-of-band so cancel has a target to reject on.
    const runA = await h.orchestrator.start('t.mt', {}, { tenantId: 'A' });
    await expect(h.orchestrator.cancel(runA.id)).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
  });

  it('listForScope() without tenantId throws MissingTenantIdError', async () => {
    await expect(
      h.runService.listForScope('acct', '1'),
    ).rejects.toBeInstanceOf(MissingTenantIdError);
  });

  it('cancelForScope() without tenantId throws MissingTenantIdError', async () => {
    await expect(
      h.runService.cancelForScope('acct', '1'),
    ).rejects.toBeInstanceOf(MissingTenantIdError);
  });

  it('rescheduleForScope() without tenantId throws MissingTenantIdError', async () => {
    await expect(
      h.runService.rescheduleForScope('acct', '1', new Date()),
    ).rejects.toBeInstanceOf(MissingTenantIdError);
  });

  it('MissingTenantIdError message names the method', async () => {
    try {
      await h.orchestrator.start('t.mt', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTenantIdError);
      expect((err as MissingTenantIdError).method).toBe('start');
      expect((err as Error).message).toContain('start');
      expect((err as Error).message).toContain('null');
    }
  });
});

// ─── Flag TRUE — explicit null opts into cross-tenant work ──────────────────

describe('multi-tenant ON — explicit null passes (cross-tenant work)', () => {
  let h: Harness;
  beforeEach(() => {
    h = build(true);
  });

  it('start({ tenantId: null }) succeeds; row persisted with tenant_id: null', async () => {
    const run = await h.orchestrator.start('t.mt', {}, { tenantId: null });
    expect(h.store.runs.get(run.id)?.tenantId).toBeNull();
  });

  it('listForScope({ tenantId: null }) returns only tenant_id: NULL rows', async () => {
    await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: 'A' },
    );
    const nullRun = await h.orchestrator.start(
      't.mt',
      {},
      { scope: { entityType: 'acct', entityId: '1' }, tenantId: null },
    );

    const rows = await h.runService.listForScope('acct', '1', { tenantId: null });
    expect(rows.map((r) => r.id)).toEqual([nullRun.id]);
  });

  it('cancel({ tenantId: null }) only cancels tenant_id NULL runs', async () => {
    const runA = await h.orchestrator.start('t.mt', {}, { tenantId: 'A' });
    const runNull = await h.orchestrator.start('t.mt', {}, { tenantId: null });

    // Null-tenant caller cannot cancel A's run.
    await h.orchestrator.cancel(runA.id, { tenantId: null });
    expect(h.store.runs.get(runA.id)?.status).toBe('pending');

    // Can cancel its own.
    await h.orchestrator.cancel(runNull.id, { tenantId: null });
    expect(h.store.runs.get(runNull.id)?.status).toBe('canceled');
  });
});
