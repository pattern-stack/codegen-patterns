
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { accounts } from '../accounts/account.entity';
import { contacts } from '../contacts/contact.entity';

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references((): AnyPgColumn => accounts.id, { onDelete: 'restrict' }),
    callerId: uuid('caller_id').references((): AnyPgColumn => contacts.id, { onDelete: 'restrict' }),
    regardingAccountId: uuid('regarding_account_id').notNull().references((): AnyPgColumn => accounts.id, { onDelete: 'restrict' }),
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('calls_caller_id_idx').on(t.callerId),
    index('calls_regarding_account_id_idx').on(t.regardingAccountId),
  ],
);

export type Call = InferSelectModel<typeof calls>;
export type CallInsert = typeof calls.$inferInsert;
