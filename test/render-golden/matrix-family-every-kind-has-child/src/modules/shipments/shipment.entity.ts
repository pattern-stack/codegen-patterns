
import {
  integer,
  pgTable,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { shipmentKindEnum } from './shipment.enums';

export { shipmentKindEnum };

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: shipmentKindEnum('kind').notNull(),
    weight: integer('weight').notNull(),
  },
  (tCols) => [
    // inherits / match: the target of a composite FK (id, kind)
    unique('shipments_id_kind_uniq').on(tCols.id, tCols.kind),
  ],
);

export type Shipment = InferSelectModel<typeof shipments>;
export type ShipmentInsert = typeof shipments.$inferInsert;
