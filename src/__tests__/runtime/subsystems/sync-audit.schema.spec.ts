/**
 * Unit tests for the sync-audit Drizzle schema (SYNC-1).
 *
 * Pure structural/metadata checks — no Postgres, no Docker. Verifies:
 *   1. the three pgTable declarations import cleanly,
 *   2. the expected columns are present on each table,
 *   3. enums carry the values the runtime/tests will depend on
 *      (`sync_runs` direction/action/status, item operation/status),
 *   4. `InferSelectModel` resolved concrete row types (no implicit `any`
 *      widening),
 *   5. the `changed_fields` column shape round-trips through
 *      `FieldDiffSchema.parse` — the ADR-0003 contract asserted at the
 *      recorder boundary (SYNC-5) is expressible against this column.
 *
 * Index assertions are intentionally omitted: Drizzle stores index metadata
 * on a non-public table symbol and there is no stable, public introspection
 * API. The presence of the indexes is enforced by the schema source itself
 * (see the index callback in `sync-audit.schema.ts`).
 */
import { describe, it, expect } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import {
  syncSubscriptions,
  syncRuns,
  syncRunItems,
  syncRunDirectionEnum,
  syncRunActionEnum,
  syncRunStatusEnum,
  syncRunItemOperationEnum,
  syncRunItemStatusEnum,
  type SyncSubscriptionRow,
  type SyncRunRow,
  type SyncRunItemRow,
} from '../../../../runtime/subsystems/sync/sync-audit.schema';
import { FieldDiffSchema } from '../../../../runtime/subsystems/sync/sync-field-diff.protocol';

describe('sync-audit.schema — import smoke', () => {
  it('exports the three pgTable declarations as objects', () => {
    expect(typeof syncSubscriptions).toBe('object');
    expect(typeof syncRuns).toBe('object');
    expect(typeof syncRunItems).toBe('object');
    expect(syncSubscriptions).not.toBeNull();
    expect(syncRuns).not.toBeNull();
    expect(syncRunItems).not.toBeNull();
  });
});

describe('sync_subscriptions — column presence', () => {
  const cols = getTableColumns(syncSubscriptions) as Record<string, unknown>;

  it.each([
    'id',
    'integrationId',
    'adapter',
    'domain',
    'externalRef',
    'enabled',
    'config',
    'cursor',
    'lastSyncAt',
    'tenantId',
    'createdAt',
    'updatedAt',
  ])('includes column %s', (key) => {
    expect(cols[key]).toBeDefined();
  });
});

describe('sync_runs — column presence', () => {
  const cols = getTableColumns(syncRuns) as Record<string, unknown>;

  it.each([
    'id',
    'subscriptionId',
    'direction',
    'action',
    'status',
    'recordsFound',
    'recordsProcessed',
    'cursorBefore',
    'cursorAfter',
    'durationMs',
    'error',
    'startedAt',
    'completedAt',
    'tenantId',
  ])('includes column %s', (key) => {
    expect(cols[key]).toBeDefined();
  });
});

describe('sync_run_items — column presence', () => {
  const cols = getTableColumns(syncRunItems) as Record<string, unknown>;

  it.each([
    'id',
    'syncRunId',
    'entityType',
    'externalId',
    'localId',
    'operation',
    'status',
    'changedFields',
    'title',
    'error',
    'createdAt',
    'tenantId',
  ])('includes column %s', (key) => {
    expect(cols[key]).toBeDefined();
  });
});

describe('enums — expected values', () => {
  it('syncRunDirectionEnum includes inbound and outbound', () => {
    expect(syncRunDirectionEnum.enumValues).toContain('inbound');
    expect(syncRunDirectionEnum.enumValues).toContain('outbound');
  });

  it('syncRunActionEnum includes the five provenance values', () => {
    for (const v of ['poll', 'cdc', 'webhook', 'manual', 'writeback']) {
      expect(syncRunActionEnum.enumValues).toContain(v);
    }
  });

  it('syncRunStatusEnum includes running/success/no_changes/failed', () => {
    for (const v of ['running', 'success', 'no_changes', 'failed']) {
      expect(syncRunStatusEnum.enumValues).toContain(v);
    }
  });

  it('syncRunItemOperationEnum includes created/updated/deleted/noop', () => {
    for (const v of ['created', 'updated', 'deleted', 'noop']) {
      expect(syncRunItemOperationEnum.enumValues).toContain(v);
    }
  });

  it('syncRunItemStatusEnum includes success/failed/skipped', () => {
    for (const v of ['success', 'failed', 'skipped']) {
      expect(syncRunItemStatusEnum.enumValues).toContain(v);
    }
  });
});

describe('row types — type-level compile checks', () => {
  it('SyncSubscriptionRow resolves to a concrete row type', () => {
    const row: SyncSubscriptionRow = {
      id: '00000000-0000-0000-0000-000000000000',
      integrationId: 'sfdc-org-abc',
      adapter: 'salesforce',
      domain: 'opportunity',
      externalRef: null,
      enabled: true,
      config: {},
      cursor: null,
      lastSyncAt: null,
      tenantId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(row.id).toBeDefined();
    expect(row.enabled).toBe(true);
  });

  it('SyncRunRow resolves to a concrete row type', () => {
    const row: SyncRunRow = {
      id: '00000000-0000-0000-0000-000000000000',
      subscriptionId: '00000000-0000-0000-0000-000000000000',
      direction: 'inbound',
      action: 'poll',
      status: 'running',
      recordsFound: 0,
      recordsProcessed: 0,
      cursorBefore: null,
      cursorAfter: null,
      durationMs: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
      tenantId: null,
    };
    expect(row.direction).toBe('inbound');
    expect(row.action).toBe('poll');
  });

  it('SyncRunItemRow resolves to a concrete row type', () => {
    const row: SyncRunItemRow = {
      id: '00000000-0000-0000-0000-000000000000',
      syncRunId: '00000000-0000-0000-0000-000000000000',
      entityType: 'opportunity',
      externalId: '006Ab00000ABC',
      localId: 'local-1',
      operation: 'updated',
      status: 'success',
      changedFields: {
        amount: { from: 92364, to: 120000 },
        stage_name: { from: 'Prospecting', to: 'Closed Won' },
      },
      title: 'Pinnacle opportunity',
      error: null,
      createdAt: new Date(),
      tenantId: null,
    };
    expect(row.operation).toBe('updated');
    expect(row.changedFields.amount).toEqual({ from: 92364, to: 120000 });
  });
});

describe('changed_fields — ADR-0003 shape round-trips through FieldDiffSchema', () => {
  // Acceptance criterion in the issue body:
  //   "Unit test asserting changed_fields JSON passes the schema"
  //
  // The column is $type<FieldDiff>-annotated; the Zod schema is what
  // enforces the contract at write time. These cases exercise the three
  // canonical shapes the recorder will produce (SYNC-5).

  it('accepts a structured per-field diff (updated record)', () => {
    const row: SyncRunItemRow['changedFields'] = {
      amount: { from: 92364, to: 120000 },
      stage_name: { from: 'Prospecting', to: 'Closed Won' },
    };
    expect(() => FieldDiffSchema.parse(row)).not.toThrow();
  });

  it('accepts an empty object (noop record)', () => {
    const row: SyncRunItemRow['changedFields'] = {};
    expect(() => FieldDiffSchema.parse(row)).not.toThrow();
  });

  it('accepts created-shape diffs (from: null, to: <value>)', () => {
    const row: SyncRunItemRow['changedFields'] = {
      amount: { from: null, to: 50_000 },
      stage_name: { from: null, to: 'Prospecting' },
    };
    expect(() => FieldDiffSchema.parse(row)).not.toThrow();
  });

  it('accepts deleted-shape diffs (from: <value>, to: null)', () => {
    const row: SyncRunItemRow['changedFields'] = {
      amount: { from: 50_000, to: null },
    };
    expect(() => FieldDiffSchema.parse(row)).not.toThrow();
  });

  it('rejects malformed values that are not the {from, to} shape', () => {
    // A plain scalar in a field slot is not the ADR-0003 shape.
    const malformed = { amount: 'not-an-object' } as unknown;
    expect(() => FieldDiffSchema.parse(malformed)).toThrow();
  });
});
