/**
 * Drizzle schema for the sync subsystem audit/observability tables (SYNC-1).
 *
 * Three tables model end-to-end sync observability, keyed by the single port
 * every sync adapter implements (`IChangeSource<T>` from SYNC-2):
 *
 *   - `sync_subscriptions` — owns the cursor per
 *       `(integration_id, adapter, domain, external_ref)` tuple. Addressed
 *       by id by `ICursorStore` (SYNC-3/SYNC-4).
 *   - `sync_runs`          — per-run audit log: start/complete, status,
 *       cursor before/after, counts, direction (inbound|outbound),
 *       action (poll|cdc|webhook|manual|writeback).
 *   - `sync_run_items`     — per-record change log with structured
 *       `changed_fields` jsonb enforced by the Zod `FieldDiffSchema`
 *       contract (ADR-0003; protocol lives in SYNC-2's
 *       sync-field-diff.protocol.ts).
 *
 * Design calls (vs. issue #126 open questions):
 *
 *   - `sync_subscriptions` ships in the subsystem (not consumer-owned).
 *     Rationale: SYNC-4's `PostgresCursorStore` needs to read/write this
 *     table directly; making it consumer-owned would require consumers to
 *     hand-wire a shape the backend already knows. The row is addressable
 *     by id and scoped by the uniqueness tuple; consumers can still
 *     query/list it freely. Same stance as `job_run` being subsystem-
 *     owned while remaining consumer-queryable.
 *
 *   - `tenant_id` is always emitted on the three tables as nullable text.
 *     The `SYNC_MULTI_TENANT` DI flag (SYNC-6) is what enforces the
 *     non-null + cross-tenant-isolation contract at the service/orchestrator
 *     boundary. This mirrors JOB-1/JOB-8's final shape — runtime guard, not
 *     a scaffold-time conditional column. Keeps the schema file uniform
 *     across single-tenant and multi-tenant deployments.
 *
 *   - `changed_fields` on `sync_run_items` is typed via the Zod-inferred
 *     `FieldDiff` shape from SYNC-2 (`{ [fieldName]: { from, to } }`). The
 *     recorder service (SYNC-5) validates every write against
 *     `FieldDiffSchema.parse` so consumers can rely on the shape.
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

import type { FieldDiff } from './sync-field-diff.protocol';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * Direction of a sync run relative to local state.
 *
 *   - `inbound`  — external → local (the common case: SFDC poll → local DB).
 *   - `outbound` — local → external (writeback; deferred per epic but the
 *     column shape is reserved so future writeback runs share the audit log).
 */
export const syncRunDirectionEnum = pgEnum('sync_run_direction', [
  'inbound',
  'outbound',
]);

/**
 * How the run detected upstream changes. Maps 1:1 to the `Change.source`
 * provenance on inbound runs; `manual` captures operator-triggered re-syncs
 * and `writeback` captures outbound runs.
 */
export const syncRunActionEnum = pgEnum('sync_run_action', [
  'poll',
  'cdc',
  'webhook',
  'manual',
  'writeback',
]);

/**
 * Lifecycle status of a sync run.
 *
 *   - `running`     — in-flight; recorder has started but not completed.
 *   - `success`     — completed with at least one change processed.
 *   - `no_changes`  — completed cleanly, no upstream changes found.
 *   - `failed`      — errored before completion; `error` column carries the
 *     message. `records_processed` may be non-zero (partial progress).
 */
export const syncRunStatusEnum = pgEnum('sync_run_status', [
  'running',
  'success',
  'no_changes',
  'failed',
]);

/**
 * Operation applied per record. Mirrors `Change<T>.operation` from SYNC-2,
 * plus the recorder's own `'noop'` for changes that matched existing state.
 */
export const syncRunItemOperationEnum = pgEnum('sync_run_item_operation', [
  'created',
  'updated',
  'deleted',
  'noop',
]);

/**
 * Per-record status within a run. `skipped` captures loopback-detected echoes
 * of the local system's own writes (see `ILoopbackFingerprintStore` in the
 * epic), which record the external_id but intentionally do not touch local
 * state.
 */
export const syncRunItemStatusEnum = pgEnum('sync_run_item_status', [
  'success',
  'failed',
  'skipped',
]);

// ─── sync_subscriptions ─────────────────────────────────────────────────────

/**
 * One cursor owner per (integration, adapter, domain, external_ref).
 *
 *   - `integration_id` — opaque id of the connected account/instance. E.g.
 *     the SFDC org id for polling strategies, the GitHub installation id
 *     for webhook strategies.
 *   - `adapter`        — short adapter label, e.g. `'salesforce'`, `'hubspot'`.
 *   - `domain`         — canonical entity domain this subscription tracks,
 *     e.g. `'opportunity'`, `'contact'`.
 *   - `external_ref`   — optional upstream scope (e.g. a filter id, a
 *     webhook subscription id). NULL when the subscription covers the
 *     entire domain.
 *
 * The cursor shape is opaque jsonb — strategies type it internally (poll:
 * `{ systemModstamp }`, cdc: `{ replayId }`, webhook: `{ ts }`). Overwritten
 * by `ICursorStore.put(id, cursor)`.
 */
export const syncSubscriptions = pgTable(
  'sync_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: text('integration_id').notNull(),
    adapter: text('adapter').notNull(),
    domain: text('domain').notNull(),
    externalRef: text('external_ref'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Per-subscription configuration bag. Strategies type it internally;
     * e.g. polling strategies stash `{ batchSize, highWatermark }` here.
     */
    config: jsonb('config').notNull().default({}).$type<Record<string, unknown>>(),
    /**
     * Opaque cursor persisted by `ICursorStore.put()`. NULL until the first
     * successful run advances it.
     */
    cursor: jsonb('cursor').$type<unknown>(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    /** Runtime-enforced when `SYNC_MULTI_TENANT` is true; see SYNC-6. */
    tenantId: text('tenant_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Composite uniqueness per the epic shape. `external_ref` is nullable;
     * Postgres treats NULLs as distinct in a UNIQUE constraint, which means
     * two rows with the same `(integration_id, adapter, domain)` and NULL
     * external_ref are allowed. That's intentional — a subscription with
     * NULL external_ref covers the full domain, and duplicates there would
     * be a consumer-layer modeling issue, not a schema concern.
     */
    uqSyncSubscriptionTuple: uniqueIndex('uq_sync_subscriptions_tuple').on(
      t.integrationId,
      t.adapter,
      t.domain,
      t.externalRef,
    ),
    /** Scheduling query: list enabled subscriptions ordered by staleness. */
    idxSyncSubscriptionsEnabledLastSync: index(
      'idx_sync_subscriptions_enabled_last_sync',
    ).on(t.enabled, t.lastSyncAt),
  }),
);

export type SyncSubscriptionRow = InferSelectModel<typeof syncSubscriptions>;

// ─── sync_runs ──────────────────────────────────────────────────────────────

/**
 * One row per invocation of `ExecuteSyncUseCase`. `started_at` is set when
 * the recorder opens the run; `completed_at`, `status`, `records_*`,
 * `cursor_after`, and `duration_ms` are filled on completion.
 *
 * `cursor_before` / `cursor_after` carry the opaque cursor snapshots so the
 * run log is fully self-describing — given a run id, an operator can reason
 * about exactly what window was scanned without cross-referencing another
 * table.
 */
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
    /** Runtime-enforced when `SYNC_MULTI_TENANT` is true; see SYNC-6. */
    tenantId: text('tenant_id'),
  },
  (t) => ({
    /** Timeline read: "most recent runs for this subscription". */
    idxSyncRunsSubscriptionStartedAt: index(
      'idx_sync_runs_subscription_started_at',
    ).on(t.subscriptionId, t.startedAt),
    /** Stale-run sweeper: "runs that started > N minutes ago and are still running". */
    idxSyncRunsStatusStartedAt: index('idx_sync_runs_status_started_at').on(
      t.status,
      t.startedAt,
    ),
  }),
);

export type SyncRunRow = InferSelectModel<typeof syncRuns>;

// ─── sync_run_items ─────────────────────────────────────────────────────────

/**
 * One row per upstream change processed within a run. Captures the canonical
 * decision the orchestrator made (`operation` + `status`), the structured
 * per-field diff (`changed_fields`, ADR-0003), and the local row id
 * (`local_id`) for drill-down joins.
 *
 * `changed_fields` is validated at the recorder layer via `FieldDiffSchema`
 * (SYNC-2) — the $type<FieldDiff> annotation here only documents the shape
 * for Drizzle consumers. The runtime enforcement is non-negotiable: downstream
 * drift-detection queries rely on the `{from, to}` shape per field.
 *
 * `title` is an optional human-readable label captured at write time (e.g.
 * `"Pinnacle opportunity"`) so run-log UIs don't need to re-hydrate the
 * canonical record.
 */
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
    /**
     * Structured per-field diff — ADR-0003 shape enforced by
     * `FieldDiffSchema.parse` at the recorder service layer.
     *
     * Shape: `{ [fieldName]: { from: unknown, to: unknown } }`.
     * Empty `{}` for `noop` items; `{ [field]: { from: null, to: <value> } }`
     * for created items; `{ [field]: { from: <value>, to: null } }` for
     * deleted items.
     */
    changedFields: jsonb('changed_fields').notNull().default({}).$type<FieldDiff>(),
    title: text('title'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Runtime-enforced when `SYNC_MULTI_TENANT` is true; see SYNC-6. */
    tenantId: text('tenant_id'),
  },
  (t) => ({
    /** Ordered timeline within a run. */
    idxSyncRunItemsRunCreatedAt: index('idx_sync_run_items_run_created_at').on(
      t.syncRunId,
      t.createdAt,
    ),
    /** Per-record history: "every sync that touched opportunity/$extId". */
    idxSyncRunItemsEntityExternal: index(
      'idx_sync_run_items_entity_external',
    ).on(t.entityType, t.externalId),
  }),
);

export type SyncRunItemRow = InferSelectModel<typeof syncRunItems>;
