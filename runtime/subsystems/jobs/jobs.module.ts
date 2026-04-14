/**
 * JobsModule — factory module for the job queue subsystem.
 *
 * Usage in AppModule (production — Postgres):
 * ```typescript
 * JobsModule.forRoot({ backend: 'drizzle' })
 * ```
 *
 * Usage in AppModule (production — Redis):
 * ```typescript
 * JobsModule.forRoot({ backend: 'redis', redisUrl: 'redis://localhost:6379' })
 * ```
 *
 * Usage in AppModule (production — BullMQ):
 * ```typescript
 * JobsModule.forRoot({ backend: 'bullmq', redisUrl: 'redis://localhost:6379' })
 * ```
 *
 * Usage in tests:
 * ```typescript
 * JobsModule.forRoot({ backend: 'memory' })
 * ```
 *
 * global: true means entity modules don't need to import JobsModule individually —
 * the JOB_QUEUE token is available project-wide once registered in AppModule.
 */
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DrizzleJobQueue } from './job-queue.drizzle-backend';
import { MemoryJobQueue } from './job-queue.memory-backend';
import { RedisJobQueue } from './job-queue.redis-backend';
import { BullMQJobQueue } from './job-queue.bullmq-backend';
import { JOB_QUEUE, REDIS_URL } from './jobs.tokens';

export interface JobsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis' | 'bullmq';
  /** Redis connection URL. Required for 'redis' and 'bullmq' backends. */
  redisUrl?: string;
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

@Module({})
export class JobsModule {
  static forRoot(options: JobsModuleOptions = { backend: 'drizzle' }): DynamicModule {
    switch (options.backend) {
      case 'redis':
        return {
          module: JobsModule,
          global: true,
          providers: [
            { provide: REDIS_URL, useValue: options.redisUrl ?? DEFAULT_REDIS_URL },
            { provide: JOB_QUEUE, useClass: RedisJobQueue },
          ],
          exports: [JOB_QUEUE],
        };

      case 'bullmq':
        return {
          module: JobsModule,
          global: true,
          providers: [
            { provide: REDIS_URL, useValue: options.redisUrl ?? DEFAULT_REDIS_URL },
            { provide: JOB_QUEUE, useClass: BullMQJobQueue },
          ],
          exports: [JOB_QUEUE],
        };

      case 'memory':
        return {
          module: JobsModule,
          global: true,
          providers: [{ provide: JOB_QUEUE, useClass: MemoryJobQueue }],
          exports: [JOB_QUEUE],
        };

      case 'drizzle':
      default:
        return {
          module: JobsModule,
          global: true,
          providers: [{ provide: JOB_QUEUE, useClass: DrizzleJobQueue }],
          exports: [JOB_QUEUE],
        };
    }
  }
}
