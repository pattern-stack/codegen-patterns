/**
 * MemoryJobQueue — in-memory job queue backend.
 *
 * Uses a Map of type → handler and processes jobs synchronously.
 * Intended for unit tests: no database required, no async polling.
 *
 * - enqueue() immediately invokes the registered handler (if any)
 * - process() stores the handler for subsequent enqueue() calls
 * - schedule() and cancel() are no-ops (test harness doesn't need them)
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ZodType } from 'zod';
import type { IJobQueue, JobOptions } from './job-queue.protocol';

@Injectable()
export class MemoryJobQueue implements IJobQueue {
  private readonly handlers = new Map<
    string,
    { handler: (payload: unknown) => Promise<void>; schema?: ZodType<unknown> }
  >();

  async enqueue<T = unknown>(type: string, payload: T, _options?: JobOptions): Promise<string> {
    const id = randomUUID();
    const entry = this.handlers.get(type);
    if (entry) {
      const validated = entry.schema ? entry.schema.parse(payload) : payload;
      await entry.handler(validated as unknown);
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
  }

  async schedule(_type: string, _cron: string, _payload?: unknown): Promise<string> {
    return randomUUID();
  }

  async cancel(_jobId: string): Promise<void> {
    // No-op in memory backend
  }
}
