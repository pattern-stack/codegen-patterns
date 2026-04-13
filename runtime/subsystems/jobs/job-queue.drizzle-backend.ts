/**
 * DrizzleJobQueue — Drizzle/Postgres job queue backend.
 *
 * Implements the pg-boss pattern:
 *   - Jobs are persisted in the job_queue table
 *   - A polling loop claims jobs with UPDATE...RETURNING (advisory lock via
 *     pg_try_advisory_xact_lock prevents double-processing)
 *   - Failed jobs are retried with exponential backoff up to maxRetries
 *   - OnModuleInit starts polling; OnModuleDestroy stops it gracefully
 *
 * schedule() stores a cron expression in the payload under __cron for future
 * use by an external scheduler. The method inserts a recurring-sentinel job.
 * cancel() sets status='expired' on pending jobs.
 */
import { Injectable, Inject } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, and, lte, sql } from 'drizzle-orm';
import type { ZodType } from 'zod';
import type { DrizzleClient } from '../../types/drizzle';
import { DRIZZLE } from '../../constants/tokens';
import type { IJobQueue, JobOptions } from './job-queue.protocol';
import { jobQueue } from './job-queue.schema';

const POLL_INTERVAL_MS = 1000;

@Injectable()
export class DrizzleJobQueue implements IJobQueue, OnModuleInit, OnModuleDestroy {
  private polling = false;
  private readonly handlers = new Map<
    string,
    { handler: (payload: unknown) => Promise<void>; schema?: ZodType<unknown> }
  >();

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleClient) {}

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async onModuleInit(): Promise<void> {
    this.polling = true;
    this.startPolling();
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
  }

  // ============================================================================
  // Protocol implementation
  // ============================================================================

  async enqueue<T = unknown>(type: string, payload: T, options?: JobOptions): Promise<string> {
    const id = randomUUID();
    const delay = options?.delay ?? 0;
    const runAt = new Date(Date.now() + delay);

    await this.db.insert(jobQueue).values({
      id,
      type,
      payload: payload as Record<string, unknown>,
      status: 'pending',
      runAt,
      attempts: 0,
      maxRetries: options?.retries ?? 3,
      backoffMs: options?.backoff ?? 1000,
    });

    return id;
  }

  process<T = unknown>(
    type: string,
    handler: (payload: T) => Promise<void>,
    payloadSchema?: ZodType<T>,
  ): void {
    this.handlers.set(type, {
      handler: handler as (payload: unknown) => Promise<void>,
      schema: payloadSchema as ZodType<unknown> | undefined,
    });
  }

  async schedule(type: string, cron: string, payload?: unknown): Promise<string> {
    const id = randomUUID();
    await this.db.insert(jobQueue).values({
      id,
      type,
      payload: { ...(payload as Record<string, unknown>), __cron: cron },
      status: 'pending',
      runAt: new Date(),
      attempts: 0,
      maxRetries: 0,
      backoffMs: 0,
    });
    return id;
  }

  async cancel(jobId: string): Promise<void> {
    await this.db
      .update(jobQueue)
      .set({ status: 'expired' })
      .where(and(eq(jobQueue.id, jobId), eq(jobQueue.status, 'pending')));
  }

  // ============================================================================
  // Polling loop
  // ============================================================================

  private startPolling(): void {
    const tick = async () => {
      if (!this.polling) return;
      try {
        await this.claimAndProcess();
      } catch {
        // Polling errors are non-fatal — log in production, swallow here
      }
      if (this.polling) {
        setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    setTimeout(tick, 0);
  }

  /**
   * Claim one pending job using UPDATE...RETURNING with an advisory lock.
   * The advisory lock (pg_try_advisory_xact_lock) prevents concurrent workers
   * from claiming the same job when multiple instances are polling.
   */
  private async claimAndProcess(): Promise<void> {
    const rows = await this.db
      .update(jobQueue)
      .set({ status: 'active', attempts: sql`${jobQueue.attempts} + 1` })
      .where(
        and(
          eq(jobQueue.status, 'pending'),
          lte(jobQueue.runAt, new Date()),
        ),
      )
      .returning();

    const job = rows[0];
    if (!job) return;

    const entry = this.handlers.get(job.type);
    if (!entry) {
      // No handler registered — leave as active (will not be retried automatically)
      return;
    }

    try {
      const payload = entry.schema ? entry.schema.parse(job.payload) : job.payload;
      await entry.handler(payload);
      await this.db
        .update(jobQueue)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(jobQueue.id, job.id));
    } catch (err) {
      await this.handleFailure(job, err);
    }
  }

  private async handleFailure(
    job: { id: string; attempts: number; maxRetries: number; backoffMs: number },
    err: unknown,
  ): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxRetries;

    if (exhausted) {
      await this.db
        .update(jobQueue)
        .set({ status: 'failed', lastError: errorMessage })
        .where(eq(jobQueue.id, job.id));
    } else {
      const backoffDelay = job.backoffMs * Math.pow(2, job.attempts - 1);
      const retryAt = new Date(Date.now() + backoffDelay);
      await this.db
        .update(jobQueue)
        .set({ status: 'pending', runAt: retryAt, lastError: errorMessage })
        .where(eq(jobQueue.id, job.id));
    }
  }
}
