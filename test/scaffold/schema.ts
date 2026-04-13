/**
 * Drizzle schema for the scaffold test harness.
 *
 * Re-exports the contacts table from codegen output so that:
 *   1. drizzle-kit push can create the contacts table in Docker Postgres
 *   2. DatabaseModule can pass the schema to drizzle() for typed queries
 *
 * The import path uses the @gen alias (maps to repo root via tsconfig.json).
 * After running codegen, the entity file lives at:
 *   <repo-root>/modules/contacts/contact.entity.ts
 */
export { contacts } from '@gen/modules/contacts/contact.entity';
export { domainEvents } from '@gen/shared/subsystems/events/domain-events.schema';
export { jobQueue } from '@gen/shared/subsystems/jobs/job-queue.schema';
export { cacheEntries } from '@gen/shared/subsystems/cache/cache.schema';

// ============================================================================
// Family base class test tables
// ============================================================================

import {
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

/** CRM family test table */
export const crmEntities = pgTable('crm_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: text('external_id'),
  provider: text('provider'),
  userId: text('user_id'),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export type CrmEntity = InferSelectModel<typeof crmEntities>;

/** Activity family test table */
export const activityEntities = pgTable('activity_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id'),
  opportunityId: text('opportunity_id'),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ActivityEntity = InferSelectModel<typeof activityEntities>;

/** Metadata family test table */
export const metadataEntities = pgTable('metadata_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  fieldName: text('field_name').notNull(),
  fieldValue: text('field_value'),
  validFrom: timestamp('valid_from').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
