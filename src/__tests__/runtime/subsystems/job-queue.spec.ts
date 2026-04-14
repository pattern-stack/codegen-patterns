/**
 * Unit tests for the jobs subsystem.
 *
 * Tests use MemoryJobQueue (no database required). DrizzleJobQueue integration
 * tests live in test/scaffold/tests/ alongside other Drizzle integration tests.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { z } from 'zod';
import { MemoryJobQueue } from '../../../../runtime/subsystems/jobs/job-queue.memory-backend';

describe('MemoryJobQueue', () => {
  let queue: MemoryJobQueue;

  beforeEach(() => {
    queue = new MemoryJobQueue();
  });

  describe('enqueue', () => {
    it('returns a UUID job ID', async () => {
      const id = await queue.enqueue('send-email', { to: 'a@b.com' });
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('invokes a registered handler synchronously', async () => {
      const received: unknown[] = [];
      queue.process('send-email', async (payload) => {
        received.push(payload);
      });

      await queue.enqueue('send-email', { to: 'a@b.com' });
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ to: 'a@b.com' });
    });

    it('does not throw when no handler is registered', async () => {
      await expect(queue.enqueue('unknown-type', {})).resolves.toBeDefined();
    });

    it('handles multiple enqueues to the same type', async () => {
      const calls: string[] = [];
      queue.process<{ id: string }>('process-item', async ({ id }) => {
        calls.push(id);
      });

      await queue.enqueue('process-item', { id: 'a' });
      await queue.enqueue('process-item', { id: 'b' });
      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('process', () => {
    it('overwrites a previously registered handler', async () => {
      const first: unknown[] = [];
      const second: unknown[] = [];

      queue.process('my-job', async (p) => { first.push(p); });
      queue.process('my-job', async (p) => { second.push(p); });

      await queue.enqueue('my-job', { x: 1 });
      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });

    it('validates payload with Zod schema when provided', async () => {
      const schema = z.object({ count: z.number() });
      const received: { count: number }[] = [];

      queue.process('count-job', async (p) => { received.push(p); }, schema);

      await queue.enqueue('count-job', { count: 42 });
      expect(received[0]).toEqual({ count: 42 });
    });

    it('throws when payload fails Zod validation', async () => {
      const schema = z.object({ count: z.number() });
      queue.process('count-job', async () => {}, schema);

      await expect(
        queue.enqueue('count-job', { count: 'not-a-number' }),
      ).rejects.toThrow();
    });

    it('passes typed payload to handler via generic', async () => {
      interface EmailPayload { to: string; subject: string }
      const received: EmailPayload[] = [];

      queue.process<EmailPayload>('typed-email', async (p) => {
        received.push(p);
      });

      await queue.enqueue<EmailPayload>('typed-email', { to: 'x@y.com', subject: 'Hi' });
      expect(received[0]).toEqual({ to: 'x@y.com', subject: 'Hi' });
    });
  });

  describe('schedule', () => {
    it('returns a UUID schedule ID', async () => {
      const id = await queue.schedule('cleanup', '0 * * * *');
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('does not throw for any cron expression', async () => {
      await expect(queue.schedule('nightly', '0 0 * * *', { region: 'us' })).resolves.toBeDefined();
    });
  });

  describe('cancel', () => {
    it('resolves without error', async () => {
      await expect(queue.cancel('any-id')).resolves.toBeUndefined();
    });
  });

  describe('handler isolation', () => {
    it('dispatches to the correct handler by type', async () => {
      const emailCalls: unknown[] = [];
      const smsCalls: unknown[] = [];

      queue.process('send-email', async (p) => { emailCalls.push(p); });
      queue.process('send-sms', async (p) => { smsCalls.push(p); });

      await queue.enqueue('send-email', { to: 'a@b.com' });
      await queue.enqueue('send-sms', { phone: '+1234' });

      expect(emailCalls).toHaveLength(1);
      expect(smsCalls).toHaveLength(1);
    });
  });
});

// ============================================================================
// JobsModule — backend factory shape
// ============================================================================

describe('JobsModule', () => {
  it('exports forRoot static method', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    expect(typeof JobsModule.forRoot).toBe('function');
  });

  it('forRoot returns DynamicModule for drizzle backend', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    const mod = JobsModule.forRoot({ backend: 'drizzle' });
    expect(mod).toHaveProperty('module');
    expect(mod).toHaveProperty('providers');
    expect(mod).toHaveProperty('exports');
    expect(mod.global).toBe(true);
  });

  it('forRoot returns DynamicModule for memory backend', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    const mod = JobsModule.forRoot({ backend: 'memory' });
    expect(mod.global).toBe(true);
    expect(mod.providers).toHaveLength(1);
  });

  it('forRoot returns DynamicModule for redis backend', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    const mod = JobsModule.forRoot({ backend: 'redis', redisUrl: 'redis://localhost:6379' });
    expect(mod.global).toBe(true);
    // Redis backend needs REDIS_URL provider + JOB_QUEUE provider
    expect(mod.providers).toHaveLength(2);
  });

  it('forRoot returns DynamicModule for bullmq backend', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    const mod = JobsModule.forRoot({ backend: 'bullmq', redisUrl: 'redis://localhost:6379' });
    expect(mod.global).toBe(true);
    expect(mod.providers).toHaveLength(2);
  });

  it('defaults to drizzle backend', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    const mod = JobsModule.forRoot();
    expect(mod.providers).toHaveLength(1);
  });

  it('accepts all four backend options', async () => {
    const { JobsModule } = await import(
      '../../../../runtime/subsystems/jobs/jobs.module'
    );
    for (const backend of ['drizzle', 'memory', 'redis', 'bullmq'] as const) {
      const mod = JobsModule.forRoot({ backend, redisUrl: 'redis://localhost:6379' });
      expect(mod).toHaveProperty('module');
    }
  });
});
