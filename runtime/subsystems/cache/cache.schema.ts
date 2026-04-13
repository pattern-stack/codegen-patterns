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
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
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
  // Index: add (expires_at) via migration for cleanup queries
);

export type CacheEntry = InferSelectModel<typeof cacheEntries>;
