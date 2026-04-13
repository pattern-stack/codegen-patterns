/**
 * IJobQueue — Job queue protocol (port).
 *
 * The protocol is the port in hexagonal architecture. Use cases inject this
 * interface via JOB_QUEUE token; they never know which backend is active.
 *
 * Backends:
 *   - DrizzleJobQueue: pg-boss pattern, persists jobs in job_queue table
 *   - MemoryJobQueue:  Map-based, synchronous dispatch (for tests)
 */
import type { ZodType } from 'zod';

export interface JobOptions {
  /** Milliseconds to wait before processing the job. */
  delay?: number;
  /** Maximum retry count. Default: 3. */
  retries?: number;
  /** Milliseconds between retries (exponential backoff base). Default: 1000. */
  backoff?: number;
  /** Higher priority jobs are claimed first. */
  priority?: number;
}

export interface IJobQueue {
  /**
   * Enqueue a job for background processing.
   * Returns the job ID.
   */
  enqueue<T = unknown>(type: string, payload: T, options?: JobOptions): Promise<string>;

  /**
   * Register a handler for a job type.
   * The optional payloadSchema validates the stored payload at runtime
   * before passing it to the handler — closing the type safety gap.
   */
  process<T = unknown>(
    type: string,
    handler: (payload: T) => Promise<void>,
    payloadSchema?: ZodType<T>,
  ): void;

  /**
   * Schedule a recurring job using a cron expression.
   * Returns a schedule ID (stored as a job with cron metadata).
   */
  schedule(type: string, cron: string, payload?: unknown): Promise<string>;

  /**
   * Cancel a pending job by ID.
   * Has no effect if the job is already active, completed, or failed.
   */
  cancel(jobId: string): Promise<void>;
}
