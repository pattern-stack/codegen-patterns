
import {
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
  },
);

export type Contact = InferSelectModel<typeof contacts>;
export type ContactInsert = typeof contacts.$inferInsert;
