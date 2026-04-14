/**
 * BullMQJobQueue — production-grade Redis job queue via BullMQ.
 *
 * BullMQ provides a mature, battle-tested queue built on Redis Streams:
 *   - Atomic job claiming (no double-processing)
 *   - Configurable retries with exponential backoff
 *   - Job delays and priorities
 *   - Cron-based repeatable jobs (native)
 *   - Concurrency control per worker
 *   - Graceful shutdown with in-flight job draining
 *
 * Mapping to IJobQueue:
 *   enqueue()  → Queue.add(type, payload, { delay, priority, attempts, backoff })
 *   process()  → creates a Worker per job type with the registered handler
 *   schedule() → Queue.add(type, payload, { repeat: { pattern: cron } })
 *   cancel()   → Job.remove()
 *
 * Connection model:
 *   BullMQ manages its own ioredis connections internally. The redisUrl is
 *   passed as a connection option. Workers each open their own connection.
 *
 * Usage:
 *   JobsModule.forRoot({ backend: 'bullmq', redisUrl: 'redis://localhost:6379' })
 *
 * Requires `bullmq`:
 *   bun add bullmq
 *
 * Note: bullmq depends on ioredis internally — you don't need to install
 * ioredis separately when using this backend.
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ZodType } from 'zod';
import type { IJobQueue, JobOptions } from './job-queue.protocol';
import { REDIS_URL } from './jobs.tokens';

// bullmq is an optional peer dependency; lazy-import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let QueueClass: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WorkerClass: any;

async function loadBullMQ(): Promise<void> {
  try {
    const mod = await import('bullmq');
    QueueClass = mod.Queue;
    WorkerClass = mod.Worker;
  } catch {
    throw new Error(
      'BullMQJobQueue requires bullmq. Install it: bun add bullmq',
    );
  }
}

/** Default queue name — all job types share one queue, differentiated by job name. */
const DEFAULT_QUEUE_NAME = 'codegen-jobs';

/** Default worker concurrency. */
const DEFAULT_CONCURRENCY = 5;

@Injectable()
export class BullMQJobQueue implements IJobQueue, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullMQJobQueue.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly workers: any[] = [];
  private readonly handlers = new Map<
    string,
    { handler: (payload: unknown) => Promise<void>; schema?: ZodType<unknown> }
  >();
  private initialized = false;

  constructor(@Inject(REDIS_URL) private readonly redisUrl: string) {}

  async onModuleInit(): Promise<void> {
    await loadBullMQ();

    const connection = this.parseRedisUrl(this.redisUrl);
    this.queue = new QueueClass(DEFAULT_QUEUE_NAME, { connection });
    this.initialized = true;

    // Start workers for any handlers registered before init
    for (const [type] of this.handlers) {
      this.createWorker(type, connection);
    }

    this.logger.log(`BullMQ queue "${DEFAULT_QUEUE_NAME}" initialized`);
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful shutdown — drain in-flight jobs
    const closePromises = this.workers.map((w: any) => w.close());
    await Promise.allSettled(closePromises);
    this.workers.length = 0;

    if (this.queue) {
      await this.queue.close();
    }

    this.logger.log('BullMQ queue shut down');
  }

  // ============================================================================
  // Protocol implementation
  // ============================================================================

  async enqueue<T = unknown>(type: string, payload: T, options?: JobOptions): Promise<string> {
    if (!this.queue) {
      throw new Error('BullMQJobQueue not initialized — call onModuleInit first');
    }

    const jobId = randomUUID();
    const bullOpts: Record<string, unknown> = {
      jobId,
      removeOnComplete: true,
      removeOnFail: 100, // keep last 100 failed jobs for debugging
    };

    if (options?.delay && options.delay > 0) {
      bullOpts.delay = options.delay;
    }
    if (options?.priority !== undefined) {
      bullOpts.priority = options.priority;
    }
    if (options?.retries !== undefined) {
      bullOpts.attempts = options.retries + 1; // BullMQ counts the first attempt
    }
    if (options?.backoff !== undefined) {
      bullOpts.backoff = {
        type: 'exponential',
        delay: options.backoff,
      };
    }

    await this.queue.add(type, payload, bullOpts);
    return jobId;
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

    if (this.initialized) {
      const connection = this.parseRedisUrl(this.redisUrl);
      this.createWorker(type, connection);
    }
  }

  async schedule(type: string, cron: string, payload?: unknown): Promise<string> {
    if (!this.queue) {
      throw new Error('BullMQJobQueue not initialized — call onModuleInit first');
    }

    const jobId = randomUUID();
    await this.queue.add(type, payload ?? {}, {
      jobId,
      repeat: { pattern: cron },
      removeOnComplete: true,
    });
    return jobId;
  }

  async cancel(jobId: string): Promise<void> {
    if (!this.queue) return;

    try {
      const job = await this.queue.getJob(jobId);
      if (job) {
        await job.remove();
      }
    } catch (err) {
      this.logger.warn(`Failed to cancel job ${jobId}: ${err}`);
    }
  }

  // ============================================================================
  // Worker management
  // ============================================================================

  private createWorker(type: string, connection: Record<string, unknown>): void {
    const entry = this.handlers.get(type);
    if (!entry) return;

    const worker = new WorkerClass(
      DEFAULT_QUEUE_NAME,
      async (job: any) => {
        // Only process jobs matching this type
        if (job.name !== type) return;

        const payload = entry.schema ? entry.schema.parse(job.data) : job.data;
        await entry.handler(payload);
      },
      {
        connection,
        concurrency: DEFAULT_CONCURRENCY,
        // Only pick up jobs matching this handler's type
        // BullMQ doesn't natively filter by name in the worker, so we
        // check job.name inside the processor. For high-throughput systems
        // with many job types, consider separate queues per type.
      },
    );

    worker.on('failed', (job: any, err: Error) => {
      this.logger.error(`Job ${job?.id} (${type}) failed: ${err.message}`);
    });

    worker.on('error', (err: Error) => {
      this.logger.error(`Worker error for ${type}: ${err.message}`);
    });

    this.workers.push(worker);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private parseRedisUrl(url: string): Record<string, unknown> {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
        db: parsed.pathname ? parseInt(parsed.pathname.slice(1) || '0', 10) : 0,
      };
    } catch {
      // Fallback for simple host:port format
      return { host: 'localhost', port: 6379 };
    }
  }
}
