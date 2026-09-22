/**
 * Drizzle schema for the scaffold test harness.
 *
 * Re-exports the generated tables from codegen output so that drizzle-kit push
 * can create them in Docker Postgres. (Under Drizzle 1.0 the
 * client no longer takes a `schema` — `drizzle({ client })` — so this barrel
 * exists for kit and for test code that imports tables directly, not for the
 * client constructor. DRZ-2, #584.)
 *
 * The import path uses the @gen alias (maps to repo root via tsconfig.json).
 * After running codegen, the entity file lives at:
 *   <repo-root>/modules/contacts/contact.entity.ts
 */
// Re-exported WHOLESALE for the same reason the subsystem schemas below are:
// an entity file also declares the pgEnums its columns reference, and
// drizzle-kit only creates enum types it can see. Naming `opportunityContacts`
// alone made `push` abort with `type "opportunity_contact_role" does not exist`.
export * from '@gen/modules/contacts/contact.entity';
// REL-1 (#586): the related set the relations round-trip traverses.
export * from '@gen/modules/accounts/account.entity';
export * from '@gen/modules/opportunities/opportunity.entity';
export * from '@gen/modules/opportunity_contacts/opportunity_contact.entity';

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
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
  // softDelete target for the per-family scope-guard tests (SCOPE-0, #616).
  deletedAt: timestamp('deleted_at'),
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
  // userTracking + softDelete targets for the per-family scope-guard tests
  // (SCOPE-0, #616). Nullable, so the family's own tests are unaffected.
  userId: text('user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

/**
 * Tenant-scoped test table (TEN-1, #585 / ADR-042).
 *
 * Carries BOTH scope axes plus the soft-delete guard, so the isolation suite
 * can prove the three predicates AND together rather than replacing one
 * another. `tenantId` is `uuid` — the same type `tenant_scoped: true` emits —
 * and nullable, so the null-tenant partition is reachable.
 */
export const tenantEntities = pgTable('tenant_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  userId: text('user_id'),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export type TenantEntity = InferSelectModel<typeof tenantEntities>;

/**
 * Tenant-scoped INTEGRATED test table (TEN-1 §5.1).
 *
 * Carries the exact constraint `tenant_scoped: true` + `external_id_tracking`
 * emits, because the property under test is a property of that constraint:
 *
 *   - the conflict target is `(tenant_id, provider, external_id)`, so two
 *     tenants may hold the same vendor id as two rows rather than one tenant's
 *     sync UPDATING the other's row;
 *   - `.nullsNotDistinct()` is load-bearing and nullable-tenant-specific.
 *     Postgres treats NULLs in a unique constraint as DISTINCT by default, so
 *     without it a null-tenant `ON CONFLICT` never fires and the upsert inserts
 *     a duplicate instead of updating. Asserted directly, not inferred.
 *
 * `unique(...)`, not `uniqueIndex(...)`: only the table-constraint builder
 * carries `.nullsNotDistinct()` on drizzle 1.0.0-rc.4.
 */
export const tenantCrmEntities = pgTable(
  'tenant_crm_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id'),
    externalId: text('external_id'),
    provider: text('provider'),
    userId: text('user_id'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    index('tenant_crm_entities_tenant_id_idx').on(t.tenantId),
    unique('uq_tenant_crm_entities_tenant_provider_external_id')
      .on(t.tenantId, t.provider, t.externalId)
      .nullsNotDistinct(),
  ],
);

export type TenantCrmEntity = InferSelectModel<typeof tenantCrmEntities>;

/**
 * Tenant-scoped METADATA test table (TEN-1 §5.2) — the caller-supplied
 * conflict-target path that must fail CLOSED rather than upsert across tenants.
 */
export const tenantMetadataEntities = pgTable('tenant_metadata_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  fieldName: text('field_name').notNull(),
  fieldValue: text('field_value'),
  validFrom: timestamp('valid_from').notNull().defaultNow(),
  userId: text('user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type TenantMetadataEntity = InferSelectModel<typeof tenantMetadataEntities>;

// ============================================================================
// CAP-3 — Actor / Communication capability test tables
// ============================================================================
//
// The shape the capability smoke's fixture generates (meeting ─roles→ contact /
// account, attendees through a junction), under `cap_` names so they cannot
// collide with the generated `contacts` table above.

export const capAccounts = pgTable('cap_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});

export const capContacts = pgTable('cap_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  capAccountId: uuid('cap_account_id').references(() => capAccounts.id),
  email: text('email').notNull(),
});

export const capMeetings = pgTable('cap_meetings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id'),
  title: text('title').notNull(),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  hostContactId: uuid('host_contact_id').references(() => capContacts.id),
  aboutAccountId: uuid('about_account_id').references(() => capAccounts.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const capMeetingContacts = pgTable(
  'cap_meeting_contacts',
  {
    capMeetingId: uuid('cap_meeting_id').notNull().references(() => capMeetings.id),
    capContactId: uuid('cap_contact_id').notNull().references(() => capContacts.id),
  },
  (t) => [primaryKey({ columns: [t.capMeetingId, t.capContactId] })],
);
