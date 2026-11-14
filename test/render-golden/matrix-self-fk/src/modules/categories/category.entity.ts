
import {
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentCategoryId: uuid('parent_category_id').notNull().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
  },
);

export type Category = InferSelectModel<typeof categories>;
export type CategoryInsert = typeof categories.$inferInsert;
