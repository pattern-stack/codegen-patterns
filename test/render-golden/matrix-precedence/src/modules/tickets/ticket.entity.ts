
import {
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { accounts } from '../accounts/account.entity';
import { users } from '../users/user.entity';

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references((): AnyPgColumn => accounts.id, { onDelete: 'restrict' }),
    assigneeId: uuid('assignee_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
);

export type Ticket = InferSelectModel<typeof tickets>;
export type TicketInsert = typeof tickets.$inferInsert;
