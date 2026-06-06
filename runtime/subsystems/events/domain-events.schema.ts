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
 *                    NULL when `tier='audit'` (audit events are not routed).
 *   - `direction`  — `inbound` | `change` | `outbound`; mirrors the routing
 *                    dimension used by jobs' reserved `events_inbound` /
 *                    `events_change` / `events_outbound` pools.
 *                    NULL when `tier='audit'`.
 *   - `tenant_id`  — conditional: emitted only when `events.multi_tenant: true`
 *                    in `codegen.config.yaml`. The runtime source declares it
 *                    unconditionally; EVT-8's scaffold template handles the
 *                    config-driven include/exclude.
 *
 * Audit-tier column (AUDIT-1):
 *   - `tier`       — `'domain'` | `'audit'`. Defaults to `'domain'`. Audit-tier
 *                    rows are observability-only (subscribers may observe but
 *                    the bridge MUST NOT spawn jobs from them); they have null
 *                    `pool` and `direction` by construction. The CHECK
 *                    constraint `domain_events_tier_routing_check` enforces
 *                    `tier='audit' ⇔ (pool IS NULL AND direction IS NULL)`.
 *
 * The `metadata` JSON column continues to carry these values for protocol
 * stability; the first-class columns are an optimization for drain filtering.
 *
 * Indexes (declared below in the index callback):
 *   - (status, occurred_at)             — polling drain filter
 *   - (aggregate_id, aggregate_type)    — event replay per aggregate
 *   - (pool, status, occurred_at)       — per-pool drain filter (EVT-1)
 *   - (tier, status, occurred_at)       — per-tier filter for the observability
 *                                          viewer's tier toggle (AUDIT-1).
 */
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    /** Routing pool (e.g. `events_inbound`, `events_change`, `events_outbound`). Populated by DrizzleEventBus.publish() in EVT-4. NULL when `tier='audit'`. */
    pool: text('pool'),
    /** Routing direction: `inbound` | `change` | `outbound`. Populated by DrizzleEventBus.publish() in EVT-4. NULL when `tier='audit'`. */
    direction: text('direction'),
    /**
     * Event tier: `'domain'` (default) or `'audit'`. Audit-tier rows are
     * observability-only and have null `pool`/`direction` by construction —
     * enforced by the `domain_events_tier_routing_check` CHECK constraint
     * declared below. (AUDIT-1)
     */
    tier: text('tier').notNull().default('domain'),
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
    /** Per-tier filter (AUDIT-1). Backs the observability viewer's tier toggle. */
    idxDomainEventsTierStatusOccurredAt: index(
      'idx_domain_events_tier_status_occurred_at',
    ).on(t.tier, t.status, t.occurredAt),
    /**
     * Scheduling idempotency — partial UNIQUE expression index (ADR-039). The
     * `EventScheduler` materialises one tick per (event type, slot) by inserting
     * with `metadata.scheduleSlot = @schedule/<type>/<slotStartMs>` and
     * `ON CONFLICT DO NOTHING`; this constraint is what makes
     * "exactly one event per slot" true across multi-instance deploys and
     * boot/tick races — no advisory lock, no leader election. Partial on the
     * extracted slot key so it only covers scheduler-materialised rows; ordinary
     * (use-case / webhook) events carry no `scheduleSlot` and are untouched.
     */
    idxDomainEventsScheduleSlot: uniqueIndex(
      'idx_domain_events_schedule_slot',
    )
      .on(t.type, sql`(${t.metadata} ->> 'scheduleSlot')`)
      .where(sql`${t.metadata} ->> 'scheduleSlot' IS NOT NULL`),
    /**
     * Tier ↔ routing-fields invariant (AUDIT-1):
     *   - `tier` is one of `'domain' | 'audit'`.
     *   - `tier='audit'` ⇔ `pool IS NULL AND direction IS NULL`.
     *   - `tier='domain'` ⇒ `pool` and `direction` are populated (the
     *     DrizzleEventBus inserts always supply them; the bus stamps them
     *     in AUDIT-3).
     */
    tierRoutingCheck: check(
      'domain_events_tier_routing_check',
      sql`${t.tier} in ('domain','audit') AND ((${t.tier} = 'audit') = (${t.pool} is null and ${t.direction} is null))`,
    ),
  }),
);

export type DomainEventRecord = InferSelectModel<typeof domainEvents>;
