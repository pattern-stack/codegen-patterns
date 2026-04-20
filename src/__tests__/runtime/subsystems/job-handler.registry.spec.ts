/**
 * Registry behaviour test for `@JobHandler` (JOB-2).
 *
 * Covers:
 *   1. decorating a class populates `JOB_HANDLER_REGISTRY` with the
 *      correct `{ type, meta, handlerClass }` shape;
 *   2. independent types register independently;
 *   3. in test mode (`NODE_ENV === 'test'`) same-type re-registration
 *      silently overwrites — last wins. Tests intentionally re-register
 *      handlers, so this is the documented behaviour;
 *   4. in production (`NODE_ENV === 'production'`) same-type re-registration
 *      throws. Silent overwrite in prod is a correctness bug.
 *
 * Every test clears the registry entries it adds in a `finally` block so
 * parallel test files aren't polluted.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  JobHandler,
  JobHandlerBase,
  JOB_HANDLER_REGISTRY,
  type JobContext,
} from '../../../../runtime/subsystems/jobs/job-handler.base';

interface AInput {
  a: string;
}
interface BInput {
  b: number;
}

const TYPE_A = 'registry-test.a';
const TYPE_B = 'registry-test.b';
const TYPE_DUP = 'registry-test.dup';
const TYPE_PROD = 'registry-test.prod-throw';

afterEach(() => {
  JOB_HANDLER_REGISTRY.delete(TYPE_A);
  JOB_HANDLER_REGISTRY.delete(TYPE_B);
  JOB_HANDLER_REGISTRY.delete(TYPE_DUP);
  JOB_HANDLER_REGISTRY.delete(TYPE_PROD);
});

describe('@JobHandler decorator — registry', () => {
  it('populates JOB_HANDLER_REGISTRY with type, meta, handlerClass', () => {
    @JobHandler<AInput>(TYPE_A, { pool: 'batch' })
    class AHandler extends JobHandlerBase<AInput, void> {
      async run(_ctx: JobContext<AInput>): Promise<void> {
        // no-op
      }
    }

    const entry = JOB_HANDLER_REGISTRY.get(TYPE_A);
    expect(entry).toBeDefined();
    expect(entry?.type).toBe(TYPE_A);
    expect(entry?.meta.pool).toBe('batch');
    expect(entry?.handlerClass).toBe(
      AHandler as unknown as typeof entry.handlerClass,
    );
  });

  it('registers independent types independently', () => {
    @JobHandler<AInput>(TYPE_A, { pool: 'batch' })
    class _AHandler extends JobHandlerBase<AInput, void> {
      async run(): Promise<void> {}
    }
    @JobHandler<BInput>(TYPE_B, { pool: 'interactive' })
    class _BHandler extends JobHandlerBase<BInput, void> {
      async run(): Promise<void> {}
    }

    void _AHandler;
    void _BHandler;

    expect(JOB_HANDLER_REGISTRY.get(TYPE_A)?.meta.pool).toBe('batch');
    expect(JOB_HANDLER_REGISTRY.get(TYPE_B)?.meta.pool).toBe('interactive');
  });

  it('in test mode, same-type re-registration silently overwrites (last wins)', () => {
    // bun:test sets NODE_ENV='test'; guard the assumption so this test
    // fails loudly if that ever changes.
    expect(process.env.NODE_ENV).toBe('test');

    @JobHandler<AInput>(TYPE_DUP, { pool: 'first' })
    class _First extends JobHandlerBase<AInput, void> {
      async run(): Promise<void> {}
    }
    @JobHandler<AInput>(TYPE_DUP, { pool: 'second' })
    class Second extends JobHandlerBase<AInput, void> {
      async run(): Promise<void> {}
    }

    void _First;

    const entry = JOB_HANDLER_REGISTRY.get(TYPE_DUP);
    expect(entry?.meta.pool).toBe('second');
    expect(entry?.handlerClass).toBe(
      Second as unknown as typeof entry.handlerClass,
    );
  });

  it('in production mode, same-type re-registration throws', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      @JobHandler<AInput>(TYPE_PROD, { pool: 'batch' })
      class _First extends JobHandlerBase<AInput, void> {
        async run(): Promise<void> {}
      }
      void _First;

      expect(() => {
        @JobHandler<AInput>(TYPE_PROD, { pool: 'batch' })
        class _Second extends JobHandlerBase<AInput, void> {
          async run(): Promise<void> {}
        }
        void _Second;
      }).toThrow(/Duplicate registration/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
