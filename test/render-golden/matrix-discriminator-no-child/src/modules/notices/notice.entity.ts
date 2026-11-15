
import {
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { noticeKindEnum } from './notice.enums';

export { noticeKindEnum };

export const notices = pgTable(
  'notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: noticeKindEnum('kind').notNull(),
    body: text('body').notNull(),
  },
  (tCols) => [
    // inherits / match: the target of a composite FK (id, kind)
    unique('notices_id_kind_uniq').on(tCols.id, tCols.kind),
  ],
);

export type Notice = InferSelectModel<typeof notices>;
export type NoticeInsert = typeof notices.$inferInsert;
