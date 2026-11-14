
import {
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
  },
);

export type Member = InferSelectModel<typeof members>;
export type MemberInsert = typeof members.$inferInsert;
