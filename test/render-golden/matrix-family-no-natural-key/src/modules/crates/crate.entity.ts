
import {
  check,
  foreignKey,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type InferSelectModel } from 'drizzle-orm';
import { parcels } from '../parcels/parcel.entity';
import { parcelKindEnum } from '../parcels/parcel.enums';

export const crates = pgTable(
  'crates',
  {
    id: uuid('id').primaryKey(), // the base row supplies it: a primary key that is also a foreign key
    kind: parcelKindEnum('kind').$type<'crate'>().notNull().default('crate'),
    label: text('label').notNull(),
  },
  (tCols) => [
    // inherits parcel: this row sits only under a parcel row whose kind is crate
    foreignKey({
      name: 'crates_parcel_kind_fk',
      columns: [tCols.id, tCols.kind],
      foreignColumns: [parcels.id, parcels.kind],
    }).onDelete('cascade'),
    // inherits parcel: the kind is fixed (DEFAULT + CHECK, not a generated column)
    check('crates_kind_check', sql`${tCols.kind} = 'crate'`),
  ],
);

export type Crate = InferSelectModel<typeof crates>;
export type CrateInsert = typeof crates.$inferInsert;
