---
to: "<%= schemaPath %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
/**
 * Drizzle schema for the integration subsystem audit/observability tables (SYNC-1).
 *
 * Three tables model end-to-end integration observability, keyed by the single
 * port every integration adapter implements (`IChangeSource<T>` from SYNC-2):
 *
 *   - `integration_subscriptions` — owns the cursor per
 *       `(connection_id, adapter, domain, external_ref)` tuple. Addressed
 *       by id by `ICursorStore` (SYNC-3/SYNC-4).
 *   - `integration_runs`          — per-run audit log: start/complete, status,
 *       cursor before/after, counts, direction + action.
 *   - `integration_run_items`     — per-record change log with structured
 *       `changed_fields` jsonb (ADR-0003). The `FieldDiff` type alias
 *       is owned by the integration subsystem's runtime protocol
 *       (`integration-field-diff.protocol.ts` from SYNC-2).
 *
 * ## `tenant_id` columns — always emitted
 *
 * `tenant_id` is emitted as a nullable text column on all three tables
 * REGARDLESS of `integration.multi_tenant` — the runtime integration code (cursor store +
 * run recorder) references `tenant_id` unconditionally, so a `multi_tenant:
 * false` consumer that omitted the column failed to type-check (the column
 * was referenced but absent). The `INTEGRATION_MULTI_TENANT` DI flag (SYNC-6) gates
 * non-null *enforcement* at runtime; it does not gate the column's existence
 * (mirrors the jobs subsystem). Under `multi_tenant: false` the column simply
 * stays null.
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
// shipped by `subsystem install integration`. If you moved that file, fix this
// import to point at the new location.
import type { FieldDiff } from './integration-field-diff.protocol';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const integrationRunDirectionEnum = pgEnum('integration_run_direction', [
  'inbound',
  'outbound',
]);

export const integrationRunActionEnum = pgEnum('integration_run_action', [
  'poll',
  'cdc',
  'webhook',
  'manual',
  'writeback',
]);

export const integrationRunStatusEnum = pgEnum('integration_run_status', [
  'running',
  'success',
  'no_changes',
  'failed',
]);

export const integrationRunItemOperationEnum = pgEnum('integration_run_item_operation', [
  'created',
  'updated',
  'deleted',
  'noop',
]);

export const integrationRunItemStatusEnum = pgEnum('integration_run_item_status', [
  'success',
  'failed',
  'skipped',
]);

// ─── integration_subscriptions ─────────────────────────────────────────────────────

export const integrationSubscriptions = pgTable(
  'integration_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: text('connection_id').notNull(),
    adapter: text('adapter').notNull(),
    domain: text('domain').notNull(),
    externalRef: text('external_ref'),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull().default({}).$type<Record<string, unknown>>(),
    cursor: jsonb('cursor').$type<unknown>(),
    lastIntegrationAt: timestamp('last_integration_at', { withTimezone: true }),
    tenantId: text('tenant_id'),                // always emitted — the runtime integration code (cursor store + run recorder) references tenant_id unconditionally; INTEGRATION_MULTI_TENANT gates enforcement, not the column's existence (mirrors jobs)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqIntegrationSubscriptionTuple: uniqueIndex('uq_integration_subscriptions_tuple').on(
      t.connectionId,
      t.adapter,
      t.domain,
      t.externalRef,
    ),
    idxIntegrationSubscriptionsEnabledLastIntegration: index(
      'idx_integration_subscriptions_enabled_last_integration',
    ).on(t.enabled, t.lastIntegrationAt),
  }),
);

export type IntegrationSubscriptionRow = InferSelectModel<typeof integrationSubscriptions>;

// ─── integration_runs ──────────────────────────────────────────────────────────────

export const integrationRuns = pgTable(
  'integration_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => integrationSubscriptions.id, { onDelete: 'cascade' }),
    direction: integrationRunDirectionEnum('direction').notNull(),
    action: integrationRunActionEnum('action').notNull(),
    status: integrationRunStatusEnum('status').notNull().default('running'),
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
    tenantId: text('tenant_id'),                // always emitted — the runtime integration code (cursor store + run recorder) references tenant_id unconditionally; INTEGRATION_MULTI_TENANT gates enforcement, not the column's existence (mirrors jobs)
  },
  (t) => ({
    idxIntegrationRunsSubscriptionStartedAt: index(
      'idx_integration_runs_subscription_started_at',
    ).on(t.subscriptionId, t.startedAt),
    idxIntegrationRunsStatusStartedAt: index('idx_integration_runs_status_started_at').on(
      t.status,
      t.startedAt,
    ),
  }),
);

export type IntegrationRunRow = InferSelectModel<typeof integrationRuns>;

// ─── integration_run_items ─────────────────────────────────────────────────────────

export const integrationRunItems = pgTable(
  'integration_run_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationRunId: uuid('integration_run_id')
      .notNull()
      .references(() => integrationRuns.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    externalId: text('external_id').notNull(),
    localId: text('local_id'),
    operation: integrationRunItemOperationEnum('operation').notNull(),
    status: integrationRunItemStatusEnum('status').notNull(),
    changedFields: jsonb('changed_fields').notNull().default({}).$type<FieldDiff>(),
    title: text('title'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    tenantId: text('tenant_id'),                // always emitted — the runtime integration code (cursor store + run recorder) references tenant_id unconditionally; INTEGRATION_MULTI_TENANT gates enforcement, not the column's existence (mirrors jobs)
  },
  (t) => ({
    idxIntegrationRunItemsRunCreatedAt: index('idx_integration_run_items_run_created_at').on(
      t.integrationRunId,
      t.createdAt,
    ),
    idxIntegrationRunItemsEntityExternal: index(
      'idx_integration_run_items_entity_external',
    ).on(t.entityType, t.externalId),
  }),
);

export type IntegrationRunItemRow = InferSelectModel<typeof integrationRunItems>;
