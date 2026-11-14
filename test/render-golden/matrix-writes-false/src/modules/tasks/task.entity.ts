
import {
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { projects } from '../projects/project.entity';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references((): AnyPgColumn => projects.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
  },
);

export type Task = InferSelectModel<typeof tasks>;
export type TaskInsert = typeof tasks.$inferInsert;
