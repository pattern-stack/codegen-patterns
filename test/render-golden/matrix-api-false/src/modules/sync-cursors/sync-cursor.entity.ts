
import {
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { accounts } from '../accounts/account.entity';

export const sync_cursors = pgTable(
  'sync_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references((): AnyPgColumn => accounts.id, { onDelete: 'restrict' }),
    position: text('position').notNull(),
  },
);

export type SyncCursor = InferSelectModel<typeof sync_cursors>;
export type SyncCursorInsert = typeof sync_cursors.$inferInsert;
