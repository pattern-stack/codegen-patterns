
import {
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
  },
);

export type Skill = InferSelectModel<typeof skills>;
export type SkillInsert = typeof skills.$inferInsert;
