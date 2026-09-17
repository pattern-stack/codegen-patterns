/**
 * Drizzle schema for the scaffold test harness.
 *
 * Re-exports the contacts table from codegen output so that drizzle-kit push
 * can create the contacts table in Docker Postgres. (Under Drizzle 1.0 the
 * client no longer takes a `schema` — `drizzle({ client })` — so this barrel
 * exists for kit and for test code that imports tables directly, not for the
 * client constructor. DRZ-2, #584.)
 *
 * The import path uses the @gen alias (maps to repo root via tsconfig.json).
 * After running codegen, the entity file lives at:
 *   <repo-root>/modules/contacts/contact.entity.ts
 */
export { contacts } from '@gen/modules/contacts/contact.entity';

// Subsystem schemas come from `@shared/*` — i.e. `runtime/subsystems/*`, the
// real source — NOT from a vendored copy generated into the repo root. One
// copy, nothing to install, nothing to clean up (GATE-1, #599).
//
// Re-exported WHOLESALE, not table-by-table: each schema also declares the
// pgEnums its columns reference, and drizzle-kit only creates enum types it can
// see. Naming individual tables made `push` abort partway ("type
// job_parent_close_policy does not exist"), leaving later tables — including
// this file's own — uncreated.
export * from '@shared/subsystems/events/domain-events.schema';
export * from '@shared/subsystems/jobs/job-orchestration.schema';
export * from '@shared/subsystems/cache/cache.schema';

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

/** Synced family test table */
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
