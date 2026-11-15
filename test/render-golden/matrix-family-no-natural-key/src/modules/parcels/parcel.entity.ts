
import {
  integer,
  pgTable,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { parcelKindEnum } from './parcel.enums';

export { parcelKindEnum };

export const parcels = pgTable(
  'parcels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: parcelKindEnum('kind').notNull(),
    weight: integer('weight').notNull(),
  },
  (tCols) => [
    // inherits / match: the target of a composite FK (id, kind)
    unique('parcels_id_kind_uniq').on(tCols.id, tCols.kind),
  ],
);

export type Parcel = InferSelectModel<typeof parcels>;
export type ParcelInsert = typeof parcels.$inferInsert;
