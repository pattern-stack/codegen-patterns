
import {
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const audit_entries = pgTable(
  'audit_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message: text('message').notNull(),
  },
);

export type AuditEntry = InferSelectModel<typeof audit_entries>;
export type AuditEntryInsert = typeof audit_entries.$inferInsert;
