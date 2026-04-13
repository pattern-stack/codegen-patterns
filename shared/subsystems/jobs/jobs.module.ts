/**
 * JobsModule — factory module for the job queue subsystem.
 *
 * Usage in AppModule (production):
 * ```typescript
 * JobsModule.forRoot({ backend: 'drizzle' })
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
import { JOB_QUEUE } from './jobs.tokens';

export interface JobsModuleOptions {
  backend: 'drizzle' | 'memory';
}

@Module({})
export class JobsModule {
  static forRoot(options: JobsModuleOptions = { backend: 'drizzle' }): DynamicModule {
    const provider =
      options.backend === 'drizzle'
        ? { provide: JOB_QUEUE, useClass: DrizzleJobQueue }
        : { provide: JOB_QUEUE, useClass: MemoryJobQueue };

    return {
      module: JobsModule,
      global: true,
      providers: [provider],
      exports: [JOB_QUEUE],
    };
  }
}
