
import {
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const field_definitions = pgTable(
  'field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull(),
    key: text('key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
);

export type FieldDefinition = InferSelectModel<typeof field_definitions>;
export type FieldDefinitionInsert = typeof field_definitions.$inferInsert;
