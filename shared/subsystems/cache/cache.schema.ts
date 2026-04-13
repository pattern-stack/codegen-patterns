/**
 * Drizzle schema for the cache_entries table.
 *
 * This table backs the DrizzleCacheService. TTL is enforced by filtering
 * on expiresAt at read time; a periodic cleanup job removes stale rows.
 *
 * Indexes:
 * - PRIMARY KEY on key (point-lookup)
 * - (expiresAt) for the cleanup query
 */
import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

export const cacheEntries = pgTable(
  'cache_entries',
  {
    /** Cache key — primary key, text (not uuid) to support arbitrary key namespacing. */
    key: text('key').primaryKey(),
    /** Cached value serialised as JSONB. */
    value: jsonb('value').notNull(),
    /** NULL means the entry never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [index('cache_entries_expires_at_idx').on(table.expiresAt)],
);

export type CacheEntry = InferSelectModel<typeof cacheEntries>;
