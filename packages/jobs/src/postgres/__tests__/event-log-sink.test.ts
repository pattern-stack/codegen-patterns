import { describe, expect, test } from 'bun:test';
import type { JobEvent } from '../../model/events.ts';
import { eventLogSink } from '../event-log-sink.ts';

const at = new Date('2026-11-23T00:00:00Z');

describe('eventLogSink', () => {
  test('appends every event but step.progress', async () => {
    const kept: JobEvent[] = [];
    const sink = eventLogSink({
      appendEvent: async (event) => {
        kept.push(event);
      },
    });
    const base = {
      runId: 'r1',
      jobKey: 'toy',
      jobVersion: 'v1',
      tenantId: 'tenant-1',
      at,
    };
    const started: JobEvent = { ...base, type: 'run.started' };
    const progress: JobEvent = {
      ...base,
      type: 'step.progress',
      step: 'score',
      attempt: 1,
      counts: { total: 2, done: 1, cached: 0, failed: 0, skipped: 0 },
    };
    await sink.emit(started);
    await sink.emit(progress);
    expect(kept).toEqual([started]);
  });
});
