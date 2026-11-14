
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { contacts } from '../contacts/contact.entity';

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadContactId: uuid('lead_contact_id').notNull().references((): AnyPgColumn => contacts.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (tCols) => [
    index('teams_lead_contact_id_idx').on(tCols.leadContactId),
  ],
);

export type Team = InferSelectModel<typeof teams>;
export type TeamInsert = typeof teams.$inferInsert;
