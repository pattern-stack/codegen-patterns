
import { pgEnum } from 'drizzle-orm/pg-core';

export const toteKindEnum = pgEnum('tote_kind', ['bin', 'loose']);
