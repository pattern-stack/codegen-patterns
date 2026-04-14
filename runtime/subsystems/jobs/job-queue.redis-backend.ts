/**
 * RedisJobQueue — lightweight Redis job queue backend.
 *
 * Uses Redis Lists for simple, reliable job processing:
 *   - enqueue() → RPUSH to jobs:{type} list (JSON-serialized job)
 *   - process() → BLPOP loop per registered type (blocking pop, atomic)
 *   - schedule() → stores cron metadata (future: external scheduler picks it up)
 *   - cancel() → LREM from the pending list
 *
 * No external dependencies beyond ioredis (already an optional peer dep).
 * For advanced features (rate limiting, job dependencies, dashboard), use
 * the BullMQ backend instead.
 *
 * Connection model:
 *   One shared ioredis client for all operations. BLPOP consumers each get
 *   their own connection (a client blocked on BLPOP can't issue other commands).
 *
 * Usage:
 *   JobsModule.forRoot({ backend: 'redis', redisUrl: 'redis://localhost:6379' })
 *
 * Requires `ioredis`:
 *   bun add ioredis
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ZodType } from 'zod';
import type { IJobQueue, JobOptions } from './job-queue.protocol';
import { REDIS_URL } from './jobs.tokens';

const KEY_PREFIX = 'jobs:';
const SCHEDULE_KEY = 'jobs:__schedules';

// ioredis is an optional peer dependency; lazy-import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

async function createRedisClient(url: string): Promise<RedisClient> {
  let Redis: { new (url: string): RedisClient };
  try {
    const mod = await import('ioredis');
    Redis = mod.default ?? mod;
  } catch {
    throw new Error(
      'RedisJobQueue requires ioredis. Install it: bun add ioredis',
    );
  }
  return new Redis(url);
}

interface SerializedJob {
  id: string;
  type: string;
  payload: unknown;
  options: JobOptions;
  createdAt: string;
  attempts: number;
}

@Injectable()
export class RedisJobQueue implements IJobQueue, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisJobQueue.name);
  private client: RedisClient;
  private running = false;
  private readonly handlers = new Map<
    string,
    { handler: (payload: unknown) => Promise<void>; schema?: ZodType<unknown> }
  >();
  private readonly consumers: Array<{ type: string; client: RedisClient }> = [];

  constructor(@Inject(REDIS_URL) private readonly redisUrl: string) {}

  async onModuleInit(): Promise<void> {
    this.client = await createRedisClient(this.redisUrl);
    this.running = true;

    // Start consumer loops for any handlers registered before init
    for (const [type] of this.handlers) {
      await this.startConsumer(type);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    // Disconnect all consumer clients
    for (const consumer of this.consumers) {
      try {
        await consumer.client.disconnect();
      } catch {
        // Swallow disconnect errors during shutdown
      }
    }
    this.consumers.length = 0;
    if (this.client) {
      await this.client.quit();
    }
  }

  // ============================================================================
  // Protocol implementation
  // ============================================================================

  async enqueue<T = unknown>(type: string, payload: T, options?: JobOptions): Promise<string> {
    const id = randomUUID();
    const job: SerializedJob = {
      id,
      type,
      payload,
      options: options ?? {},
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    const key = KEY_PREFIX + type;

    if (options?.delay && options.delay > 0) {
      // Delayed jobs: store in a sorted set scored by execution time,
      // a separate loop promotes them to the list when ready.
      // For simplicity in v1, we use setTimeout + RPUSH.
      setTimeout(async () => {
        try {
          await this.client.rpush(key, JSON.stringify(job));
        } catch (err) {
          this.logger.error(`Failed to enqueue delayed job ${id}: ${err}`);
        }
      }, options.delay);
    } else {
      await this.client.rpush(key, JSON.stringify(job));
    }

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

    // If already running, start a consumer for this type
    if (this.running) {
      this.startConsumer(type).catch((err) => {
        this.logger.error(`Failed to start consumer for ${type}: ${err}`);
      });
    }
  }

  async schedule(type: string, cron: string, payload?: unknown): Promise<string> {
    const id = randomUUID();
    const schedule = { id, type, cron, payload, createdAt: new Date().toISOString() };
    await this.client.hset(SCHEDULE_KEY, id, JSON.stringify(schedule));
    return id;
  }

  async cancel(jobId: string): Promise<void> {
    // Scan all type lists for the job — not efficient for large queues,
    // but correct. Production systems should use BullMQ for O(1) cancel.
    const keys = await this.client.keys(KEY_PREFIX + '*');
    for (const key of keys) {
      if (key === SCHEDULE_KEY) continue;
      const items: string[] = await this.client.lrange(key, 0, -1);
      for (const item of items) {
        try {
          const job = JSON.parse(item) as SerializedJob;
          if (job.id === jobId) {
            await this.client.lrem(key, 1, item);
            return;
          }
        } catch {
          // Skip malformed entries
        }
      }
    }
    // Also check schedules
    await this.client.hdel(SCHEDULE_KEY, jobId);
  }

  // ============================================================================
  // Consumer loop
  // ============================================================================

  private async startConsumer(type: string): Promise<void> {
    // Each consumer needs its own connection (BLPOP blocks the connection)
    const consumerClient = await createRedisClient(this.redisUrl);
    this.consumers.push({ type, client: consumerClient });

    const key = KEY_PREFIX + type;
    const entry = this.handlers.get(type);
    if (!entry) return;

    const loop = async () => {
      while (this.running) {
        try {
          // BLPOP blocks until an item is available (5s timeout to check running flag)
          const result = await consumerClient.blpop(key, 5);
          if (!result) continue; // timeout, loop again

          const [, raw] = result;
          const job = JSON.parse(raw) as SerializedJob;
          const payload = entry.schema ? entry.schema.parse(job.payload) : job.payload;

          try {
            await entry.handler(payload);
          } catch (err) {
            const maxRetries = job.options.retries ?? 3;
            job.attempts += 1;

            if (job.attempts < maxRetries) {
              const backoff = (job.options.backoff ?? 1000) * Math.pow(2, job.attempts - 1);
              this.logger.warn(
                `Job ${job.id} failed (attempt ${job.attempts}/${maxRetries}), retrying in ${backoff}ms`,
              );
              setTimeout(async () => {
                try {
                  await this.client.rpush(key, JSON.stringify(job));
                } catch (e) {
                  this.logger.error(`Failed to re-enqueue job ${job.id}: ${e}`);
                }
              }, backoff);
            } else {
              this.logger.error(
                `Job ${job.id} exhausted ${maxRetries} retries: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        } catch (err) {
          if (this.running) {
            this.logger.error(`Consumer error for ${type}: ${err}`);
            // Brief pause before retrying the loop
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    };

    // Fire and forget — runs until onModuleDestroy sets running=false
    loop().catch((err) => {
      this.logger.error(`Consumer loop for ${type} terminated: ${err}`);
    });
  }
}
