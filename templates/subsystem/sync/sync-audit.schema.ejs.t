---
to: "<%= schemaPath %>"
force: true
---
/**
 * Drizzle schema for the sync subsystem audit/observability tables (SYNC-1).
 *
 * Three tables model end-to-end sync observability, keyed by the single
 * port every sync adapter implements (`IChangeSource<T>` from SYNC-2):
 *
 *   - `sync_subscriptions` — owns the cursor per
 *       `(integration_id, adapter, domain, external_ref)` tuple. Addressed
 *       by id by `ICursorStore` (SYNC-3/SYNC-4).
 *   - `sync_runs`          — per-run audit log: start/complete, status,
 *       cursor before/after, counts, direction + action.
 *   - `sync_run_items`     — per-record change log with structured
 *       `changed_fields` jsonb (ADR-0003). The `FieldDiff` type alias
 *       is owned by the sync subsystem's runtime protocol
 *       (`sync-field-diff.protocol.ts` from SYNC-2).
 *
 * ## `tenant_id` columns — scaffold-time conditional
 *
 * When `sync.multi_tenant: true` in `codegen.config.yaml`, this schema
 * emits `tenant_id` as a nullable text column on all three tables. The
 * `SYNC_MULTI_TENANT` DI flag (SYNC-6) enforces non-null at runtime
 * across the orchestrator + Drizzle backends. Enabling post-install
 * requires reinstalling this subsystem (`subsystem install sync --force
 * --force-config`) plus an Atlas migration.
 *
 * See SYNC-1 / SYNC-6 in epic #60 for the decision rationale.
 */
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

// NOTE: the `FieldDiff` type alias is imported from the runtime protocol
// shipped by `subsystem install sync`. If you moved that file, fix this
// import to point at the new location.
import type { FieldDiff } from './sync-field-diff.protocol';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const syncRunDirectionEnum = pgEnum('sync_run_direction', [
  'inbound',
  'outbound',
]);

export const syncRunActionEnum = pgEnum('sync_run_action', [
  'poll',
  'cdc',
  'webhook',
  'manual',
  'writeback',
]);

export const syncRunStatusEnum = pgEnum('sync_run_status', [
  'running',
  'success',
  'no_changes',
  'failed',
]);

export const syncRunItemOperationEnum = pgEnum('sync_run_item_operation', [
  'created',
  'updated',
  'deleted',
  'noop',
]);

export const syncRunItemStatusEnum = pgEnum('sync_run_item_status', [
  'success',
  'failed',
  'skipped',
]);

// ─── sync_subscriptions ─────────────────────────────────────────────────────

export const syncSubscriptions = pgTable(
  'sync_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: text('integration_id').notNull(),
    adapter: text('adapter').notNull(),
    domain: text('domain').notNull(),
    externalRef: text('external_ref'),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull().default({}).$type<Record<string, unknown>>(),
    cursor: jsonb('cursor').$type<unknown>(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
<% if (multiTenant) { -%>
    tenantId: text('tenant_id'),                // scaffold-time conditional — see sync.multi_tenant
<% } -%>
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqSyncSubscriptionTuple: uniqueIndex('uq_sync_subscriptions_tuple').on(
      t.integrationId,
      t.adapter,
      t.domain,
      t.externalRef,
    ),
    idxSyncSubscriptionsEnabledLastSync: index(
      'idx_sync_subscriptions_enabled_last_sync',
    ).on(t.enabled, t.lastSyncAt),
  }),
);

export type SyncSubscriptionRow = InferSelectModel<typeof syncSubscriptions>;

// ─── sync_runs ──────────────────────────────────────────────────────────────

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => syncSubscriptions.id, { onDelete: 'cascade' }),
    direction: syncRunDirectionEnum('direction').notNull(),
    action: syncRunActionEnum('action').notNull(),
    status: syncRunStatusEnum('status').notNull().default('running'),
    recordsFound: integer('records_found').notNull().default(0),
    recordsProcessed: integer('records_processed').notNull().default(0),
    cursorBefore: jsonb('cursor_before').$type<unknown>(),
    cursorAfter: jsonb('cursor_after').$type<unknown>(),
    durationMs: integer('duration_ms'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
<% if (multiTenant) { -%>
    tenantId: text('tenant_id'),                // scaffold-time conditional — see sync.multi_tenant
<% } -%>
  },
  (t) => ({
    idxSyncRunsSubscriptionStartedAt: index(
      'idx_sync_runs_subscription_started_at',
    ).on(t.subscriptionId, t.startedAt),
    idxSyncRunsStatusStartedAt: index('idx_sync_runs_status_started_at').on(
      t.status,
      t.startedAt,
    ),
  }),
);

export type SyncRunRow = InferSelectModel<typeof syncRuns>;

// ─── sync_run_items ─────────────────────────────────────────────────────────

export const syncRunItems = pgTable(
  'sync_run_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    syncRunId: uuid('sync_run_id')
      .notNull()
      .references(() => syncRuns.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    externalId: text('external_id').notNull(),
    localId: text('local_id'),
    operation: syncRunItemOperationEnum('operation').notNull(),
    status: syncRunItemStatusEnum('status').notNull(),
    changedFields: jsonb('changed_fields').notNull().default({}).$type<FieldDiff>(),
    title: text('title'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
<% if (multiTenant) { -%>
    tenantId: text('tenant_id'),                // scaffold-time conditional — see sync.multi_tenant
<% } -%>
  },
  (t) => ({
    idxSyncRunItemsRunCreatedAt: index('idx_sync_run_items_run_created_at').on(
      t.syncRunId,
      t.createdAt,
    ),
    idxSyncRunItemsEntityExternal: index(
      'idx_sync_run_items_entity_external',
    ).on(t.entityType, t.externalId),
  }),
);

export type SyncRunItemRow = InferSelectModel<typeof syncRunItems>;
