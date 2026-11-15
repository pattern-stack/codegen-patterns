
import {
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
  },
);

export type Workspace = InferSelectModel<typeof workspaces>;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
