import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { JobEvent } from '../../index.ts';
import { recordingSink } from '../../testing.ts';
import { activeSpanSink, fanOut } from '../event-sinks.ts';

const base = {
  runId: 'run-1',
  jobKey: 'toy.job',
  jobVersion: 'v1',
  tenantId: 'tenant-1',
  at: new Date('2026-11-15T12:00:00Z'),
};
const canceled: JobEvent = { ...base, type: 'run.canceled' };

describe('fanOut', () => {
  it('reaches every sink when one throws, and reports the failure by type, never its message', async () => {
    const warn = mock((_message: string) => {});
    const after = recordingSink();
    const failing = {
      emit: async () => {
        throw new TypeError('secret provider text');
      },
    };
    await fanOut([failing, after], { warn }).emit(canceled);
    expect(after.types()).toEqual(['run.canceled']);
    expect(warn).toHaveBeenCalledWith(
      'a job event sink failed on run.canceled (TypeError)',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});

describe('activeSpanSink', () => {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager();

  it('does nothing with no tracer provider registered (no SDK, no span)', async () => {
    await activeSpanSink().emit({
      ...base,
      type: 'run.failed',
      errorType: 'X',
    });
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  describe('with an SDK', () => {
    beforeAll(() => {
      context.setGlobalContextManager(contextManager.enable());
      trace.setGlobalTracerProvider(
        new BasicTracerProvider({
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
      );
    });

    afterAll(() => {
      trace.disable();
      context.disable();
    });

    it('annotates the active span with counts and an ERROR status, and creates no span', async () => {
      const tracer = trace.getTracer('host');
      await tracer.startActiveSpan('job-engine-run', async (span) => {
        const sink = activeSpanSink();
        await sink.emit({
          ...base,
          type: 'step.completed',
          step: 'judge',
          attempt: 1,
          counts: { total: 4, done: 3, cached: 1, failed: 0, skipped: 0 },
          speculation: { speculated: 4, used: 3, overshoot: 1 },
        });
        await sink.emit({
          ...base,
          type: 'step.failed',
          step: 'judge',
          attempt: 1,
          errorType: 'ThrottledError',
        });
        await sink.emit(canceled);
        span.end();
      });
      const spans = exporter.getFinishedSpans();
      expect(spans.map((s) => s.name)).toEqual(['job-engine-run']);
      const [span] = spans;
      expect(span?.attributes).toEqual({
        'jobs.step.judge.total': 4,
        'jobs.step.judge.done': 3,
        'jobs.step.judge.cached': 1,
        'jobs.step.judge.failed': 0,
        'jobs.step.judge.skipped': 0,
        'jobs.step.judge.speculation.speculated': 4,
        'jobs.step.judge.speculation.used': 3,
        'jobs.step.judge.speculation.overshoot': 1,
      });
      expect(span?.status).toEqual({
        code: SpanStatusCode.ERROR,
        message: 'ThrottledError',
      });
    });

    it('does nothing outside an active span', async () => {
      exporter.reset();
      await activeSpanSink().emit({
        ...base,
        type: 'run.failed',
        errorType: 'X',
      });
      expect(exporter.getFinishedSpans()).toEqual([]);
    });
  });
});
