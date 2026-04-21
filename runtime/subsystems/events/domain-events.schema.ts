/**
 * Drizzle schema for the domain_events outbox table.
 *
 * This table backs the DrizzleEventBus. Events are inserted within the
 * same database transaction as the domain write (outbox pattern). A
 * polling process reads unprocessed rows and dispatches to subscribers.
 *
 * First-class routing columns (EVT-1):
 *   - `pool`       — populated by DrizzleEventBus.publish() (EVT-4); enables
 *                    pool-filtered drain queries without unpacking metadata JSON.
 *   - `direction`  — `inbound` | `change` | `outbound`; mirrors the routing
 *                    dimension used by jobs' reserved `events_inbound` /
 *                    `events_change` / `events_outbound` pools.
 *   - `tenant_id`  — conditional: emitted only when `events.multi_tenant: true`
 *                    in `codegen.config.yaml`. The runtime source declares it
 *                    unconditionally; EVT-8's scaffold template handles the
 *                    config-driven include/exclude.
 *
 * The `metadata` JSON column continues to carry these values for protocol
 * stability; the first-class columns are an optimization for drain filtering.
 *
 * Indexes (declared below in the index callback):
 *   - (status, occurred_at)             — polling drain filter
 *   - (aggregate_id, aggregate_type)    — event replay per aggregate
 *   - (pool, status, occurred_at)       — per-pool drain filter (EVT-1)
 */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** Lifecycle status: pending | processed | failed */
    status: text('status').notNull().default('pending'),
    /** Error message from the last failed dispatch attempt. */
    error: text('error'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** Routing pool (e.g. `events_inbound`, `events_change`, `events_outbound`). Populated by DrizzleEventBus.publish() in EVT-4. */
    pool: text('pool'),
    /** Routing direction: `inbound` | `change` | `outbound`. Populated by DrizzleEventBus.publish() in EVT-4. */
    direction: text('direction'),
    // conditional: emitted only when events.multi_tenant: true
    tenantId: text('tenant_id'),
  },
  (t) => ({
    /** Polling drain filter (existing — promoted from comment to declaration in EVT-1). */
    idxDomainEventsStatusOccurredAt: index('idx_domain_events_status_occurred_at').on(
      t.status,
      t.occurredAt,
    ),
    /** Event replay per aggregate (existing — promoted from comment to declaration in EVT-1). */
    idxDomainEventsAggregate: index('idx_domain_events_aggregate').on(
      t.aggregateId,
      t.aggregateType,
    ),
    /** Per-pool drain filter (EVT-1). Enables DrizzleEventBus to drain a single pool without scanning all events. */
    idxDomainEventsPoolStatusOccurredAt: index(
      'idx_domain_events_pool_status_occurred_at',
    ).on(t.pool, t.status, t.occurredAt),
  }),
);

export type DomainEventRecord = InferSelectModel<typeof domainEvents>;
