
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const field_values = pgTable(
  'field_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldDefinitionId: uuid('field_definition_id').notNull(),
    userId: uuid('user_id').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
);

export type FieldValue = InferSelectModel<typeof field_values>;
export type FieldValueInsert = typeof field_values.$inferInsert;
