
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

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostContactId: uuid('host_contact_id').notNull().references((): AnyPgColumn => contacts.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('meetings_host_contact_id_idx').on(t.hostContactId),
  ],
);

export type Meeting = InferSelectModel<typeof meetings>;
export type MeetingInsert = typeof meetings.$inferInsert;
