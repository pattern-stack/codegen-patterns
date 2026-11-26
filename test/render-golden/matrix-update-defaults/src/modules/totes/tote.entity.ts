
import {
  boolean,
  pgTable,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { toteKindEnum } from './tote.enums';

export { toteKindEnum };

export const totes = pgTable(
  'totes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: toteKindEnum('kind').notNull(),
    fragile: boolean('fragile').default(false),
  },
  (tCols) => [
    // inherits / match: the target of a composite FK (id, kind)
    unique('totes_id_kind_uniq').on(tCols.id, tCols.kind),
  ],
);

export type Tote = InferSelectModel<typeof totes>;
export type ToteInsert = typeof totes.$inferInsert;
