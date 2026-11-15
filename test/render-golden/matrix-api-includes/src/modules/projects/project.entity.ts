
import {
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { accounts } from '../accounts/account.entity';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references((): AnyPgColumn => accounts.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
  },
);

export type Project = InferSelectModel<typeof projects>;
export type ProjectInsert = typeof projects.$inferInsert;
