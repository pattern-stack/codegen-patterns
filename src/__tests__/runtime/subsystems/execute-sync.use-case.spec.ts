/**
 * Unit tests for ExecuteSyncUseCase (SYNC-5).
 *
 * Pure bun:test — no DI container, no Postgres. Constructs the orchestrator
 * by passing ports positionally (NestJS decorator injection is not engaged
 * in unit tests — we bypass it and wire dependencies directly). Covers the
 * acceptance list in issue #130:
 *
 *   - created / updated / deleted happy paths
 *   - noop emission when differ returns 'noop'
 *   - per-item failure does not fail the whole run; counts.failed increments
 *   - cursor advance on successful run
 *
 * Plus: all-failed run is marked 'failed'; empty iterable → 'no_changes';
 * source iterator throw still persists last-good cursor; deletion of a
 * missing record records as 'noop'.
 *
 * Loopback suppression moved out of the orchestrator in #226-5 — it now
 * lives in `createLoopbackMiddleware(store)` and is asserted in
 * `loopback.middleware.spec.ts`. The orchestrator no longer special-cases
 * echoes; tests here stop covering that branch.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryCursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.memory-backend';
import { DeepEqualDiffer } from '../../../../runtime/subsystems/sync/deep-equal.differ';
import { ExecuteSyncUseCase } from '../../../../runtime/subsystems/sync/execute-sync.use-case';
import type {
  Change,
  IChangeSource,
  SyncSubscriptionView,
} from '../../../../runtime/subsystems/sync/sync-change-source.protocol';
import type { ISyncSink } from '../../../../runtime/subsystems/sync/sync-sink.protocol';
import type {
  ISyncRunRecorder,
  RecordItemInput,
  CompleteRunInput,
} from '../../../../runtime/subsystems/sync/sync-run-recorder.protocol';

// ─── Canonical shape for tests ──────────────────────────────────────────────

interface CanonicalOpp extends Record<string, unknown> {
  external_id: string;
  amount?: number;
  stageName?: string;
}

// ─── Inline fakes ───────────────────────────────────────────────────────────

class ArrayChangeSource implements IChangeSource<CanonicalOpp> {
  readonly label = 'test-array';
  readonly seenCursors: Array<unknown | null> = [];
  constructor(private readonly changes: Change<CanonicalOpp>[]) {}
  async *listChanges(
    _sub: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpp>> {
    this.seenCursors.push(cursor);
    for (const c of this.changes) yield c;
  }
}

class ThrowingChangeSource implements IChangeSource<CanonicalOpp> {
  readonly label = 'test-throw';
  constructor(
    private readonly initial: Change<CanonicalOpp>[],
    private readonly err: Error,
  ) {}
  async *listChanges(
    _sub: SyncSubscriptionView,
    _cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpp>> {
    for (const c of this.initial) yield c;
    throw this.err;
  }
}

class FakeSink implements ISyncSink<CanonicalOpp> {
  readonly rows = new Map<string, CanonicalOpp>();
  /** External ids for which `upsertByExternalId` should throw. */
  failOn = new Set<string>();

  async findByExternalId(
    _userId: string,
    externalId: string,
  ): Promise<CanonicalOpp | null> {
    return this.rows.get(externalId) ?? null;
  }

  async upsertByExternalId(
    _userId: string,
    record: CanonicalOpp,
    _provider: string,
  ): Promise<{ id: string; saved: CanonicalOpp }> {
    if (this.failOn.has(record.external_id)) {
      throw new Error(`sink boom for ${record.external_id}`);
    }
    const localId = `local-${record.external_id}`;
    this.rows.set(record.external_id, record);
    return { id: localId, saved: record };
  }

  async softDeleteByExternalId(
    _userId: string,
    externalId: string,
  ): Promise<{ id: string } | null> {
    if (!this.rows.has(externalId)) return null;
    this.rows.delete(externalId);
    return { id: `local-${externalId}` };
  }
}

class FakeRecorder implements ISyncRunRecorder {
  readonly starts: Array<{ runId: string; input: unknown }> = [];
  readonly items: RecordItemInput[] = [];
  readonly completions: Array<{ runId: string; input: CompleteRunInput }> = [];
  private nextId = 1;

  async startRun(input: Parameters<ISyncRunRecorder['startRun']>[0]): Promise<{
    id: string;
  }> {
    const id = `run-${this.nextId++}`;
    this.starts.push({ runId: id, input });
    return { id };
  }

  async recordItem(input: RecordItemInput): Promise<void> {
    this.items.push(input);
  }

  async completeRun(runId: string, input: CompleteRunInput): Promise<void> {
    this.completions.push({ runId, input });
  }
}

// ─── Shared fixtures ────────────────────────────────────────────────────────

const SUB: SyncSubscriptionView = {
  id: 'sub-1',
  domain: 'opportunity',
  externalRef: null,
};

function makeInput(overrides: Partial<{
  tenantId: string | null;
  direction: 'inbound' | 'outbound';
  action: 'poll' | 'cdc' | 'webhook' | 'manual' | 'writeback';
}> = {}) {
  return {
    subscription: SUB,
    userId: 'user-1',
    provider: 'salesforce-crm',
    direction: 'inbound' as const,
    action: 'poll' as const,
    tenantId: null,
    ...overrides,
  };
}

function makeOrchestrator(
  source: IChangeSource<CanonicalOpp>,
  sink: ISyncSink<CanonicalOpp>,
  recorder: ISyncRunRecorder,
  cursors: MemoryCursorStore,
) {
  return new ExecuteSyncUseCase<CanonicalOpp>(
    source,
    cursors,
    new DeepEqualDiffer<CanonicalOpp>(),
    sink,
    recorder,
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ExecuteSyncUseCase', () => {
  let cursors: MemoryCursorStore;
  let sink: FakeSink;
  let recorder: FakeRecorder;

  beforeEach(() => {
    cursors = new MemoryCursorStore();
    sink = new FakeSink();
    recorder = new FakeRecorder();
  });

  describe('empty iterable', () => {
    it('records no_changes and does not advance cursor', async () => {
      const source = new ArrayChangeSource([]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      const result = await orch.execute(makeInput());

      expect(result.status).toBe('no_changes');
      expect(result.recordsFound).toBe(0);
      expect(result.recordsProcessed).toBe(0);
      expect(result.cursorAfter).toBeNull();
      expect(await cursors.get(SUB.id)).toBeNull();
      expect(recorder.completions[0]?.input.status).toBe('no_changes');
      expect(recorder.items).toHaveLength(0);
    });
  });

  describe('created happy path', () => {
    it('upserts, records operation=created, advances cursor', async () => {
      const change: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'created',
        record: { external_id: 'ext-1', amount: 100, stageName: 'Prospecting' },
        cursor: { systemModstamp: '2026-04-21T13:00:00Z' },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      const result = await orch.execute(makeInput());

      expect(result.status).toBe('success');
      expect(result.recordsFound).toBe(1);
      expect(result.recordsProcessed).toBe(1);
      expect(result.recordsFailed).toBe(0);
      expect(result.cursorAfter).toEqual({
        systemModstamp: '2026-04-21T13:00:00Z',
      });
      expect(await cursors.get(SUB.id)).toEqual({
        systemModstamp: '2026-04-21T13:00:00Z',
      });
      expect(sink.rows.get('ext-1')).toEqual(change.record);
      expect(recorder.items).toHaveLength(1);
      expect(recorder.items[0].operation).toBe('created');
      expect(recorder.items[0].status).toBe('success');
      expect(recorder.items[0].localId).toBe('local-ext-1');
      expect(recorder.items[0].changedFields).toEqual({
        external_id: { from: null, to: 'ext-1' },
        amount: { from: null, to: 100 },
        stageName: { from: null, to: 'Prospecting' },
      });
    });
  });

  describe('updated happy path', () => {
    it('diffs, upserts, records operation=updated with changed_fields', async () => {
      sink.rows.set('ext-1', {
        external_id: 'ext-1',
        amount: 100,
        stageName: 'Prospecting',
      });
      const change: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'updated',
        record: {
          external_id: 'ext-1',
          amount: 120,
          stageName: 'Prospecting',
        },
        cursor: { systemModstamp: 'c2' },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(recorder.items[0].operation).toBe('updated');
      expect(recorder.items[0].changedFields).toEqual({
        amount: { from: 100, to: 120 },
      });
    });
  });

  describe('deleted happy path', () => {
    it('soft-deletes, records operation=deleted', async () => {
      sink.rows.set('ext-1', { external_id: 'ext-1', amount: 100 });
      const change: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'deleted',
        record: { external_id: 'ext-1' },
        cursor: { systemModstamp: 'c3' },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(sink.rows.has('ext-1')).toBe(false);
      expect(recorder.items[0].operation).toBe('deleted');
      expect(recorder.items[0].localId).toBe('local-ext-1');
      expect(recorder.items[0].changedFields).toEqual({});
    });

    it('records noop when deleting a missing record', async () => {
      const change: Change<CanonicalOpp> = {
        externalId: 'missing',
        operation: 'deleted',
        record: { external_id: 'missing' },
        cursor: { v: 1 },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(recorder.items[0].operation).toBe('noop');
      expect(recorder.items[0].localId).toBeNull();
    });
  });

  describe('noop emission', () => {
    it('records noop without calling upsert when differ returns noop', async () => {
      const existing: CanonicalOpp = {
        external_id: 'ext-1',
        amount: 100,
        stageName: 'Prospecting',
      };
      sink.rows.set('ext-1', existing);
      const change: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'updated',
        record: { ...existing },
        cursor: { v: 1 },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(recorder.items[0].operation).toBe('noop');
      expect(recorder.items[0].changedFields).toEqual({});
      // Sink.upsertByExternalId was not called — row in the map is the
      // pre-existing reference (the change-record copy would also equal,
      // but we assert `upsertByExternalId` did not run by checking the
      // map still points to `existing`).
      expect(sink.rows.get('ext-1')).toBe(existing);
    });
  });

  describe('per-item failure', () => {
    it('failed item does not abort the run; counts.failed increments', async () => {
      sink.failOn.add('boom');
      const changes: Change<CanonicalOpp>[] = [
        {
          externalId: 'boom',
          operation: 'created',
          record: { external_id: 'boom', amount: 100 },
          cursor: { v: 1 },
          source: 'poll',
        },
        {
          externalId: 'ok',
          operation: 'created',
          record: { external_id: 'ok', amount: 200 },
          cursor: { v: 2 },
          source: 'poll',
        },
      ];
      const source = new ArrayChangeSource(changes);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      const result = await orch.execute(makeInput());

      expect(result.recordsFound).toBe(2);
      expect(result.recordsProcessed).toBe(1);
      expect(result.recordsFailed).toBe(1);
      expect(result.status).toBe('success');
      expect(await cursors.get(SUB.id)).toEqual({ v: 2 });

      const boomItem = recorder.items.find((i) => i.externalId === 'boom');
      const okItem = recorder.items.find((i) => i.externalId === 'ok');
      expect(boomItem?.status).toBe('failed');
      expect(boomItem?.error).toContain('sink boom for boom');
      expect(okItem?.status).toBe('success');
    });

    it('all-failed run → status=failed, cursor STILL advances', async () => {
      sink.failOn.add('a');
      sink.failOn.add('b');
      const changes: Change<CanonicalOpp>[] = [
        {
          externalId: 'a',
          operation: 'created',
          record: { external_id: 'a' },
          cursor: { v: 1 },
          source: 'poll',
        },
        {
          externalId: 'b',
          operation: 'created',
          record: { external_id: 'b' },
          cursor: { v: 2 },
          source: 'poll',
        },
      ];
      const source = new ArrayChangeSource(changes);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      const result = await orch.execute(makeInput());

      expect(result.status).toBe('failed');
      expect(result.recordsFailed).toBe(2);
      expect(result.error).toContain('all 2 records failed');
      // Cursor advanced — per-item failures are recorded but the source
      // kept yielding, so the cursor position moved. Re-running wouldn't
      // re-deliver these records. This is a deliberate call: retrying is
      // the caller's job (via a manual re-sync or a dead-letter replay).
      expect(await cursors.get(SUB.id)).toEqual({ v: 2 });
    });
  });

  describe('source iterator throw', () => {
    it('persists the last-good cursor and marks the run failed', async () => {
      const goodChange: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'created',
        record: { external_id: 'ext-1', amount: 100 },
        cursor: { v: 1 },
        source: 'poll',
      };
      const source = new ThrowingChangeSource(
        [goodChange],
        new Error('session expired'),
      );
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      const result = await orch.execute(makeInput());

      expect(result.status).toBe('failed');
      expect(result.error).toContain('session expired');
      expect(result.recordsProcessed).toBe(1);
      // Cursor is the last successful change the iterator yielded.
      expect(await cursors.get(SUB.id)).toEqual({ v: 1 });
      expect(recorder.completions[0]?.input.status).toBe('failed');
    });

    it('handles source throwing before any change yields', async () => {
      const source = new ThrowingChangeSource([], new Error('connect timeout'));
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      const result = await orch.execute(makeInput());

      expect(result.status).toBe('failed');
      expect(result.recordsFound).toBe(0);
      expect(await cursors.get(SUB.id)).toBeNull();
    });
  });

  describe('tenantId propagation', () => {
    it('passes tenantId to startRun, recordItem, and the result', async () => {
      const change: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'created',
        record: { external_id: 'ext-1', amount: 100 },
        cursor: { v: 1 },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput({ tenantId: 'tenant-a' }));

      expect((recorder.starts[0].input as { tenantId?: string }).tenantId).toBe(
        'tenant-a',
      );
      expect(recorder.items[0].tenantId).toBe('tenant-a');
    });
  });

  describe('cursor passthrough (#226-2)', () => {
    it('passes null cursor on first run (no prior persisted cursor)', async () => {
      const source = new ArrayChangeSource([]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(source.seenCursors).toEqual([null]);
    });

    it('passes the persisted cursor value on subsequent runs', async () => {
      // Seed the cursor store with a prior value.
      await cursors.put(SUB.id, { systemModstamp: '2026-04-21T10:00:00Z' });

      const change: Change<CanonicalOpp> = {
        externalId: 'ext-1',
        operation: 'created',
        record: { external_id: 'ext-1', amount: 100 },
        cursor: { systemModstamp: '2026-04-21T13:00:00Z' },
        source: 'poll',
      };
      const source = new ArrayChangeSource([change]);
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(source.seenCursors).toEqual([
        { systemModstamp: '2026-04-21T10:00:00Z' },
      ]);
    });
  });

  describe('always completes run (finally semantics)', () => {
    it('completeRun fires even if the source throws immediately', async () => {
      const source = new ThrowingChangeSource([], new Error('boom'));
      const orch = makeOrchestrator(source, sink, recorder, cursors);
      await orch.execute(makeInput());

      expect(recorder.completions).toHaveLength(1);
      expect(recorder.completions[0].input.status).toBe('failed');
    });
  });
});
