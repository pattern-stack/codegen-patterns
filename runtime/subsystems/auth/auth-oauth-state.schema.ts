/**
 * Drizzle schema for the `auth_oauth_state` table — backs the
 * `DrizzleOAuthStateStore` (`state-store.drizzle-backend.ts`).
 *
 * One row per outstanding /connect → /callback dance. Single-use; rows are
 * deleted on consume. A periodic sweep (or a `WHERE expires_at < now()`
 * filter on read) clears abandoned rows.
 *
 * Columns:
 *   - `state`       — opaque random token, primary key.
 *   - `user_id`     — text (matches the consumer-defined user-id shape;
 *                     the auth subsystem doesn't constrain this to UUID
 *                     because some apps key users by external id).
 *   - `redirect`    — optional post-callback redirect path.
 *   - `expires_at`  — TTL boundary; entries past this are treated as absent.
 *
 * Convention: schema files live at the root of the subsystem dir
 * (mirrors `cache.schema.ts`, `integration-audit.schema.ts`, `domain-events.schema.ts`).
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

export const authOAuthState = pgTable('auth_oauth_state', {
  state: text('state').primaryKey(),
  userId: text('user_id').notNull(),
  redirect: text('redirect'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type AuthOAuthState = InferSelectModel<typeof authOAuthState>;
