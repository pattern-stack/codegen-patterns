
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // external_id_tracking behavior
    externalId: varchar('external_id'),
    provider: varchar('provider'),
    providerMetadata: jsonb('provider_metadata'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (tCols) => [
    // external_id_tracking behavior — ON CONFLICT target for integrationUpsert
    uniqueIndex('uq_leads_provider_external_id').on(tCols.provider, tCols.externalId),
  ],
);

export type Lead = InferSelectModel<typeof leads>;
export type LeadInsert = typeof leads.$inferInsert;
