
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type InferSelectModel } from 'drizzle-orm';
import { totes } from '../totes/tote.entity';
import { toteKindEnum } from '../totes/tote.enums';

export const bins = pgTable(
  'bins',
  {
    id: uuid('id').primaryKey(), // the base row supplies it: a primary key that is also a foreign key
    kind: toteKindEnum('kind').$type<'bin'>().notNull().default('bin'),
    label: text('label').notNull(),
    sealed: boolean('sealed').default(true),
  },
  (tCols) => [
    // inherits tote: this row sits only under a tote row whose kind is bin
    foreignKey({
      name: 'bins_tote_kind_fk',
      columns: [tCols.id, tCols.kind],
      foreignColumns: [totes.id, totes.kind],
    }).onDelete('cascade'),
    // inherits tote: the kind is fixed (DEFAULT + CHECK, not a generated column)
    check('bins_kind_check', sql`${tCols.kind} = 'bin'`),
  ],
);

export type Bin = InferSelectModel<typeof bins>;
export type BinInsert = typeof bins.$inferInsert;
