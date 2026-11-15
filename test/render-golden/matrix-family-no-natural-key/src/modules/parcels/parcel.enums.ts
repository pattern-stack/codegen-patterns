
import { pgEnum } from 'drizzle-orm/pg-core';

export const parcelKindEnum = pgEnum('parcel_kind', ['crate', 'loose']);
