
import {
  boolean,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const shelves = pgTable(
  'shelves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    active: boolean('active').default(true),
    archived: boolean('archived').default(false),
  },
);

export type Shelf = InferSelectModel<typeof shelves>;
export type ShelfInsert = typeof shelves.$inferInsert;
