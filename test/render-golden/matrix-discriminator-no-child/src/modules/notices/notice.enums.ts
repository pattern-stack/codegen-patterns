
import { pgEnum } from 'drizzle-orm/pg-core';

export const noticeKindEnum = pgEnum('notice_kind', ['info', 'alert']);
