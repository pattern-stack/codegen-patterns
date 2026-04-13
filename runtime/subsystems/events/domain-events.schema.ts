/**
 * Drizzle schema for the domain_events outbox table.
 *
 * This table backs the DrizzleEventBus. Events are inserted within the
 * same database transaction as the domain write (outbox pattern). A
 * polling process reads unprocessed rows and dispatches to subscribers.
 *
 * Indexes:
 *   - (type, processedAt) — polling query filter
 *   - (aggregateId, aggregateType) — event replay per aggregate
 */
import {
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
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  // Indexes: add via migration when deploying
  // - (type, processed_at) for polling
  // - (aggregate_id, aggregate_type) for replay
);

export type DomainEventRecord = InferSelectModel<typeof domainEvents>;
