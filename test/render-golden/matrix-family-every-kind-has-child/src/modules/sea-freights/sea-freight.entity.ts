
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

export const sea_freights = pgTable(
  'sea_freights',
  {
    id: uuid('id').primaryKey(), // the base row supplies it: a primary key that is also a foreign key
    kind: shipmentKindEnum('kind').$type<'sea'>().notNull().default('sea'),
    vessel: text('vessel').notNull(),
  },
  (tCols) => [
    // inherits shipment: this row sits only under a shipment row whose kind is sea
    foreignKey({
      name: 'sea_freights_shipment_kind_fk',
      columns: [tCols.id, tCols.kind],
      foreignColumns: [shipments.id, shipments.kind],
    }).onDelete('cascade'),
    // inherits shipment: the kind is fixed (DEFAULT + CHECK, not a generated column)
    check('sea_freights_kind_check', sql`${tCols.kind} = 'sea'`),
  ],
);

export type SeaFreight = InferSelectModel<typeof sea_freights>;
export type SeaFreightInsert = typeof sea_freights.$inferInsert;
