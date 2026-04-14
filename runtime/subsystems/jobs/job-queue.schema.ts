/**
 * Drizzle schema for the job_queue table.
 *
 * Follows the pg-boss pattern: jobs are persisted with status, retry tracking,
 * and scheduling metadata. Two composite indexes support the polling query and
 * routing.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'expired';

export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Job type — matches the type registered via process(). */
    type: text('type').notNull(),
    /** Arbitrary JSON payload passed to the handler. */
    payload: jsonb('payload').notNull().default({}),
    /** Current job lifecycle status. */
    status: text('status').notNull().default('pending').$type<JobStatus>(),
    /** Earliest time the job may be claimed. */
    runAt: timestamp('run_at').notNull().defaultNow(),
    /** Higher priority jobs are claimed first (ORDER BY priority DESC). */
    priority: integer('priority').notNull().default(0),
    /** Number of processing attempts made so far. */
    attempts: integer('attempts').notNull().default(0),
    /** Maximum number of retries before status → failed. */
    maxRetries: integer('max_retries').notNull().default(3),
    /** Base backoff in ms (doubles on each retry). */
    backoffMs: integer('backoff_ms').notNull().default(1000),
    /** Error message from the last failed attempt. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
    /** When the job was last claimed by a worker (used for stale job recovery). */
    claimedAt: timestamp('claimed_at'),
  },
  // Indexes: add via migration when deploying
  // - (status, run_at) for claim query
  // - (type, status) for routing
);

export type JobRow = InferSelectModel<typeof jobQueue>;
