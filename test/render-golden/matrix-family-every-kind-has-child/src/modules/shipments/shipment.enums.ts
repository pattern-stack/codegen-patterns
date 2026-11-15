
import { pgEnum } from 'drizzle-orm/pg-core';

export const shipmentKindEnum = pgEnum('shipment_kind', ['air', 'sea']);
