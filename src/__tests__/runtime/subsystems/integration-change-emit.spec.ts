/**
 * ExecuteIntegrationUseCase — EMIT-CHANGES seam behavior tests.
 *
 * Drives the orchestrator with the memory backends + inline fakes (mirrors
 * `integration.module.spec.ts`) and asserts the optional
 * `INTEGRATION_CHANGE_EMITTER` is invoked exactly at the points the spec
 * demands:
 *   - created (new local row)  → emitChange(action:'created', changedFields set)
 *   - updated (existing row)   → emitChange(action:'updated', changedFields set)
 *   - deleted (real tombstone) → emitChange(action:'deleted', no changedFields)
 *   - delete miss (no row)     → NO emit (nothing changed)
 *   - noop diff                → NO emit (canonical unchanged)
 *   - no emitter bound         → NO emit, run still succeeds (back-compat)
 *   - emitter throws           → run does NOT fail (best-effort emission)
 */
import 'reflect-metadata';
import { describe, it, expect } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { IntegrationModule } from '../../../../runtime/subsystems/integration/integration.module';
import {
  INTEGRATION_CHANGE_EMITTER,
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_SINK,
} from '../../../../runtime/subsystems/integration/integration.tokens';
import { ExecuteIntegrationUseCase } from '../../../../runtime/subsystems/integration/execute-integration.use-case';
import type {
  Change,
  IChangeSource,
  IntegrationSubscriptionView,
} from '../../../../runtime/subsystems/integration/integration-change-source.protocol';
import type { IIntegrationSink } from '../../../../runtime/subsystems/integration/integration-sink.protocol';
import type {
  IIntegrationChangeEmitter,
  IntegrationChangeNotification,
} from '../../../../runtime/subsystems/integration/integration-change-emitter.protocol';

// ─── Canonical + fakes ──────────────────────────────────────────────────────

interface CanonicalMsg extends Record<string, unknown> {
  external_id: string;
  text?: string;
}

/** A source that yields a fixed list of changes. */
class ScriptedSource implements IChangeSource<CanonicalMsg> {
  readonly label = 'test';
  constructor(private readonly changes: Array<Change<CanonicalMsg>>) {}
  async *listChanges(
    _sub: IntegrationSubscriptionView,
    _cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalMsg>> {
    for (const c of this.changes) yield c;
  }
}

/**
 * A sink whose `findByExternalId` returns whatever is in its `existing` map
 * (drives created-vs-updated), and whose soft-delete returns a row only for ids
 * in `deletable`.
 */
class MapSink implements IIntegrationSink<CanonicalMsg> {
  constructor(
    private readonly existing: Map<string, CanonicalMsg> = new Map(),
    private readonly deletable: Set<string> = new Set(),
  ) {}
  async findByExternalId(
    _userId: string,
    externalId: string,
  ): Promise<CanonicalMsg | null> {
    return this.existing.get(externalId) ?? null;
  }
  async upsertByExternalId(
    _userId: string,
    record: CanonicalMsg,
  ): Promise<{ id: string; saved: CanonicalMsg }> {
    return { id: `local-${record.external_id}`, saved: record };
  }
  async softDeleteByExternalId(
    _userId: string,
    externalId: string,
  ): Promise<{ id: string } | null> {
    return this.deletable.has(externalId) ? { id: `local-${externalId}` } : null;
  }
}

/** Records every emitChange call; optionally throws to prove best-effort. */
class SpyEmitter implements IIntegrationChangeEmitter {
  readonly calls: IntegrationChangeNotification[] = [];
  constructor(private readonly shouldThrow = false) {}
  async emitChange(notification: IntegrationChangeNotification): Promise<void> {
    this.calls.push(notification);
    if (this.shouldThrow) throw new Error('emit boom');
  }
}

function input() {
  return {
    subscription: { id: 'sub-1', domain: 'message' },
    userId: 'user-1',
    provider: 'slack',
    direction: 'inbound' as const,
    action: 'poll' as const,
  };
}

async function runWith(opts: {
  changes: Array<Change<CanonicalMsg>>;
  existing?: Map<string, CanonicalMsg>;
  deletable?: Set<string>;
  emitter?: IIntegrationChangeEmitter | null;
}) {
  const sink = new MapSink(opts.existing, opts.deletable);
  const providers = [
    {
      provide: INTEGRATION_CHANGE_SOURCE,
      useValue: new ScriptedSource(opts.changes),
    },
    { provide: INTEGRATION_SINK, useValue: sink },
    ExecuteIntegrationUseCase,
  ];
  if (opts.emitter) {
    providers.push({
      provide: INTEGRATION_CHANGE_EMITTER,
      useValue: opts.emitter,
    });
  }

  @Module({ providers })
  class FeatureModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ backend: 'memory' }), FeatureModule],
  }).compile();

  const orch = moduleRef.get(ExecuteIntegrationUseCase);
  const result = await orch.execute(input());
  await moduleRef.close();
  return result;
}

function created(externalId: string): Change<CanonicalMsg> {
  return {
    externalId,
    operation: 'created',
    record: { external_id: externalId, text: 'hi' },
    cursor: { v: externalId },
    source: 'poll',
  };
}

function deleted(externalId: string): Change<CanonicalMsg> {
  return {
    externalId,
    operation: 'deleted',
    record: { external_id: externalId },
    cursor: { v: externalId },
    source: 'poll',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ExecuteIntegrationUseCase — EMIT-CHANGES seam', () => {
  it('emits created for a brand-new local row, with the differ changedFields', async () => {
    const emitter = new SpyEmitter();
    await runWith({ changes: [created('ext-1')], emitter });

    expect(emitter.calls).toHaveLength(1);
    const call = emitter.calls[0]!;
    expect(call.action).toBe('created');
    expect(call.entityId).toBe('local-ext-1');
    expect(call.externalId).toBe('ext-1');
    expect(call.provider).toBe('slack');
    // a brand-new row diffs every field → changedFields present
    expect(call.changedFields).toBeDefined();
  });

  it('emits updated when a local row already exists', async () => {
    const emitter = new SpyEmitter();
    await runWith({
      changes: [
        {
          externalId: 'ext-2',
          operation: 'created', // adapter labels it 'created'; orchestrator decides via findByExternalId
          record: { external_id: 'ext-2', text: 'new text' },
          cursor: { v: 2 },
          source: 'poll',
        },
      ],
      existing: new Map([['ext-2', { external_id: 'ext-2', text: 'old text' }]]),
      emitter,
    });

    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]!.action).toBe('updated');
    expect(emitter.calls[0]!.changedFields).toBeDefined();
  });

  it('does NOT emit on a noop diff (canonical unchanged)', async () => {
    const emitter = new SpyEmitter();
    await runWith({
      changes: [
        {
          externalId: 'ext-3',
          operation: 'created',
          record: { external_id: 'ext-3', text: 'same' },
          cursor: { v: 3 },
          source: 'poll',
        },
      ],
      existing: new Map([['ext-3', { external_id: 'ext-3', text: 'same' }]]),
      emitter,
    });

    expect(emitter.calls).toHaveLength(0);
  });

  it('emits deleted for a real tombstone, with no changedFields', async () => {
    const emitter = new SpyEmitter();
    await runWith({
      changes: [deleted('ext-4')],
      deletable: new Set(['ext-4']),
      emitter,
    });

    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]!.action).toBe('deleted');
    expect(emitter.calls[0]!.entityId).toBe('local-ext-4');
    expect(emitter.calls[0]!.changedFields).toBeUndefined();
  });

  it('does NOT emit when a delete hits no local row (nothing changed)', async () => {
    const emitter = new SpyEmitter();
    await runWith({
      changes: [deleted('ext-5')],
      deletable: new Set(), // no row → soft-delete returns null
      emitter,
    });

    expect(emitter.calls).toHaveLength(0);
  });

  it('is a no-op when no emitter is bound — run still succeeds (back-compat)', async () => {
    const result = await runWith({ changes: [created('ext-6')], emitter: null });
    expect(result.status).toBe('success');
    expect(result.recordsProcessed).toBe(1);
  });

  it('a throwing emitter does NOT fail the run (best-effort emission)', async () => {
    const emitter = new SpyEmitter(true);
    const result = await runWith({ changes: [created('ext-7')], emitter });
    // emit threw, but the item + run still succeeded.
    expect(emitter.calls).toHaveLength(1);
    expect(result.status).toBe('success');
    expect(result.recordsProcessed).toBe(1);
    expect(result.recordsFailed).toBe(0);
  });

  it('threads tenantId through to the emitter when multi-tenant', async () => {
    const emitter = new SpyEmitter();
    const sink = new MapSink();
    @Module({
      providers: [
        {
          provide: INTEGRATION_CHANGE_SOURCE,
          useValue: new ScriptedSource([created('ext-8')]),
        },
        { provide: INTEGRATION_SINK, useValue: sink },
        { provide: INTEGRATION_CHANGE_EMITTER, useValue: emitter },
        ExecuteIntegrationUseCase,
      ],
    })
    class MtFeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({ backend: 'memory', multiTenant: true }),
        MtFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteIntegrationUseCase);
    await orch.execute({ ...input(), tenantId: 'tenant-1' });
    await moduleRef.close();

    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]!.tenantId).toBe('tenant-1');
  });
});
