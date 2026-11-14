
import {
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
  },
);

export type Account = InferSelectModel<typeof accounts>;
export type AccountInsert = typeof accounts.$inferInsert;
