
import {
  check,
  foreignKey,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type InferSelectModel } from 'drizzle-orm';
import { shipments } from '../shipments/shipment.entity';
import { shipmentKindEnum } from '../shipments/shipment.enums';

export const air_freights = pgTable(
  'air_freights',
  {
    id: uuid('id').primaryKey(), // the base row supplies it: a primary key that is also a foreign key
    kind: shipmentKindEnum('kind').$type<'air'>().notNull().default('air'),
    flight: text('flight').notNull(),
  },
  (tCols) => [
    // inherits shipment: this row sits only under a shipment row whose kind is air
    foreignKey({
      name: 'air_freights_shipment_kind_fk',
      columns: [tCols.id, tCols.kind],
      foreignColumns: [shipments.id, shipments.kind],
    }).onDelete('cascade'),
    // inherits shipment: the kind is fixed (DEFAULT + CHECK, not a generated column)
    check('air_freights_kind_check', sql`${tCols.kind} = 'air'`),
  ],
);

export type AirFreight = InferSelectModel<typeof air_freights>;
export type AirFreightInsert = typeof air_freights.$inferInsert;
