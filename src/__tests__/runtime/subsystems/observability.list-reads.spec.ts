/**
 * OBS-LIST-1 — unit tests for the observability combiner's row-level reads:
 * `listJobRuns`, `listEvents`, and `getCorrelationTimeline`.
 *
 * Three axes:
 *   1. Delegation — listJobRuns/listEvents forward the query verbatim to the
 *      owning port and return its page unchanged.
 *   2. Missing-port degradation — when JOB_RUN_SERVICE / EVENT_READ_PORT is
 *      absent, the read returns an empty page; the timeline degrades to zero
 *      counts (ADR-025 §61).
 *   3. getCorrelationTimeline — stitches runs + events into one ascending
 *      timeline, drains multi-page sibling results via the keyset cursor,
 *      and computes the summary.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';

import {
  OBSERVABILITY,
  type EventPage,
  type IObservability,
  type JobRunPage,
} from '../../../../runtime/subsystems/observability';
import { ObservabilityService } from '../../../../runtime/subsystems/observability/observability.service';

import { JOB_RUN_SERVICE } from '../../../../runtime/subsystems/jobs/jobs-domain.tokens';
import type {
  IJobRunService,
  JobRunPage as JRP,
  JobRunSummary,
  ListJobRunsQuery,
} from '../../../../runtime/subsystems/jobs/job-run-service.protocol';
import type { JobRun } from '../../../../runtime/subsystems/jobs/job-orchestrator.protocol';

import { EVENT_READ_PORT } from '../../../../runtime/subsystems/events/events.tokens';
import type {
  EventPage as EP,
  EventSummary,
  IEventReadPort,
  ListEventsQuery,
} from '../../../../runtime/subsystems/events/event-read.protocol';

// ─── Fakes ─────────────────────────────────────────────────────────────────

type Call = { method: string; args: readonly unknown[] };

function jobSummary(over: Partial<JobRunSummary> & Pick<JobRunSummary, 'runId' | 'createdAt'>): JobRunSummary {
  return {
    runId: over.runId,
    rootRunId: over.rootRunId ?? 'root-1',
    jobType: over.jobType ?? 'test.job',
    pool: over.pool ?? 'p',
    status: over.status ?? 'completed',
    scopeEntityType: over.scopeEntityType ?? null,
    scopeEntityId: over.scopeEntityId ?? null,
    tenantId: over.tenantId ?? null,
    attempts: over.attempts ?? 0,
    errorMessage: over.errorMessage ?? null,
    runAt: over.runAt ?? over.createdAt,
    startedAt: over.startedAt ?? null,
    finishedAt: over.finishedAt ?? null,
    createdAt: over.createdAt,
  };
}

function eventSummary(over: Partial<EventSummary> & Pick<EventSummary, 'id' | 'occurredAt'>): EventSummary {
  return {
    id: over.id,
    type: over.type ?? 'thing_happened',
    aggregateId: over.aggregateId ?? 'agg-1',
    aggregateType: over.aggregateType ?? 'thing',
    status: over.status ?? 'processed',
    pool: over.pool ?? null,
    direction: over.direction ?? null,
    tier: over.tier ?? 'domain',
    rootRunId: over.rootRunId ?? 'root-1',
    tenantId: over.tenantId ?? null,
    occurredAt: over.occurredAt,
    processedAt: over.processedAt ?? over.occurredAt,
  };
}

class FakeJobRunService implements Partial<IJobRunService> {
  calls: Call[] = [];
  /** Each entry is one page returned in sequence. */
  pages: JRP[] = [{ items: [], nextCursor: null }];
  private idx = 0;

  async listJobRuns(query?: ListJobRunsQuery): Promise<JRP> {
    this.calls.push({ method: 'listJobRuns', args: [query] });
    const page = this.pages[Math.min(this.idx, this.pages.length - 1)]!;
    this.idx += 1;
    return page;
  }

  // Unused protocol members — present so the cast to IJobRunService is honest.
  listForScope(): Promise<JobRun[]> { throw new Error('not used'); }
  cancelForScope(): Promise<void> { throw new Error('not used'); }
  rescheduleForScope(): Promise<void> { throw new Error('not used'); }
  countByPoolAndStatus(): Promise<never> { throw new Error('not used'); }
  listRecentFailed(): Promise<never> { throw new Error('not used'); }
}

class FakeEventReadPort implements IEventReadPort {
  calls: Call[] = [];
  pages: EP[] = [{ items: [], nextCursor: null }];
  private idx = 0;

  async listEvents(query?: ListEventsQuery): Promise<EP> {
    this.calls.push({ method: 'listEvents', args: [query] });
    const page = this.pages[Math.min(this.idx, this.pages.length - 1)]!;
    this.idx += 1;
    return page;
  }
}

async function buildModule(opts: { jobRuns?: FakeJobRunService; events?: FakeEventReadPort }) {
  const providers: import('@nestjs/common').Provider[] = [
    ObservabilityService,
    { provide: OBSERVABILITY, useExisting: ObservabilityService },
  ];
  if (opts.jobRuns) providers.push({ provide: JOB_RUN_SERVICE, useValue: opts.jobRuns });
  if (opts.events) providers.push({ provide: EVENT_READ_PORT, useValue: opts.events });
  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const obs = moduleRef.get(OBSERVABILITY) as IObservability;
  return { moduleRef, obs };
}

// ─── listJobRuns / listEvents delegation ─────────────────────────────────────

describe('ObservabilityService.listJobRuns', () => {
  it('forwards the query and returns the port page verbatim', async () => {
    const jobRuns = new FakeJobRunService();
    const expected: JobRunPage = {
      items: [jobSummary({ runId: 'r1', createdAt: new Date('2026-01-01T00:00:00Z') })],
      nextCursor: 'CUR',
    };
    jobRuns.pages = [expected];
    const { obs } = await buildModule({ jobRuns });

    const query = { poolId: 'batch', status: 'failed' as const, limit: 10 };
    const result = await obs.listJobRuns(query);
    expect(result).toEqual(expected);
    expect(jobRuns.calls).toEqual([{ method: 'listJobRuns', args: [query] }]);
  });

  it('returns an empty page when JOB_RUN_SERVICE is absent', async () => {
    const { obs } = await buildModule({});
    expect(await obs.listJobRuns({ poolId: 'p' })).toEqual({ items: [], nextCursor: null });
  });
});

describe('ObservabilityService.listEvents', () => {
  it('forwards the query and returns the port page verbatim', async () => {
    const events = new FakeEventReadPort();
    const expected: EventPage = {
      items: [eventSummary({ id: 'e1', occurredAt: new Date('2026-01-01T00:00:00Z') })],
      nextCursor: 'EC',
    };
    events.pages = [expected];
    const { obs } = await buildModule({ events });

    const query = { rootRunId: 'root-1', direction: 'change', limit: 5 };
    const result = await obs.listEvents(query);
    expect(result).toEqual(expected);
    expect(events.calls).toEqual([{ method: 'listEvents', args: [query] }]);
  });

  it('returns an empty page when EVENT_READ_PORT is absent (degradation)', async () => {
    const { obs } = await buildModule({});
    expect(await obs.listEvents({ rootRunId: 'root-1' })).toEqual({ items: [], nextCursor: null });
  });

  it('returns an empty page when EVENT_READ_PORT resolves to null (redis backend)', async () => {
    // Mirrors EventsModule binding EVENT_READ_PORT to null on the redis
    // backend: the token is present but the value is null.
    const moduleRef = await Test.createTestingModule({
      providers: [
        ObservabilityService,
        { provide: OBSERVABILITY, useExisting: ObservabilityService },
        { provide: EVENT_READ_PORT, useValue: null },
      ],
    }).compile();
    const obs = moduleRef.get(OBSERVABILITY) as IObservability;
    expect(await obs.listEvents()).toEqual({ items: [], nextCursor: null });
  });
});

// ─── getCorrelationTimeline ──────────────────────────────────────────────────

describe('ObservabilityService.getCorrelationTimeline', () => {
  it('stitches runs + events into one ascending timeline with a summary', async () => {
    const jobRuns = new FakeJobRunService();
    jobRuns.pages = [
      {
        items: [
          jobSummary({ runId: 'run-root', createdAt: new Date('2026-01-01T00:00:00Z') }),
          jobSummary({ runId: 'run-child', createdAt: new Date('2026-01-01T00:00:05Z') }),
        ],
        nextCursor: null,
      },
    ];
    const events = new FakeEventReadPort();
    events.pages = [
      {
        items: [eventSummary({ id: 'evt-1', occurredAt: new Date('2026-01-01T00:00:03Z') })],
        nextCursor: null,
      },
    ];
    const { obs } = await buildModule({ jobRuns, events });

    const timeline = await obs.getCorrelationTimeline('root-1');

    expect(timeline.rootRunId).toBe('root-1');
    // Ascending: run@00, event@03, run@05.
    expect(timeline.entries.map((e) => (e.kind === 'job_run' ? e.run.runId : e.event.id))).toEqual([
      'run-root',
      'evt-1',
      'run-child',
    ]);
    expect(timeline.summary).toEqual({
      runCount: 2,
      eventCount: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      lastActivityAt: new Date('2026-01-01T00:00:05Z'),
    });

    // The timeline filters both ports by rootRunId.
    expect(jobRuns.calls[0]!.args[0]).toMatchObject({ rootRunId: 'root-1' });
    expect(events.calls[0]!.args[0]).toMatchObject({ rootRunId: 'root-1' });
  });

  it('drains multi-page sibling results via the keyset cursor', async () => {
    const jobRuns = new FakeJobRunService();
    jobRuns.pages = [
      { items: [jobSummary({ runId: 'r1', createdAt: new Date('2026-01-01T00:00:00Z') })], nextCursor: 'C1' },
      { items: [jobSummary({ runId: 'r2', createdAt: new Date('2026-01-01T00:00:01Z') })], nextCursor: null },
    ];
    const { obs } = await buildModule({ jobRuns });

    const timeline = await obs.getCorrelationTimeline('root-1');
    expect(timeline.summary.runCount).toBe(2);
    // Second call carried the cursor from the first page.
    expect(jobRuns.calls).toHaveLength(2);
    expect((jobRuns.calls[1]!.args[0] as ListJobRunsQuery).cursor).toBe('C1');
  });

  it('degrades to an empty timeline when neither sibling is installed', async () => {
    const { obs } = await buildModule({});
    const timeline = await obs.getCorrelationTimeline('root-1');
    expect(timeline).toEqual({
      rootRunId: 'root-1',
      entries: [],
      summary: { runCount: 0, eventCount: 0, startedAt: null, lastActivityAt: null },
    });
  });

  it('works with only the jobs subsystem present (events absent)', async () => {
    const jobRuns = new FakeJobRunService();
    jobRuns.pages = [
      { items: [jobSummary({ runId: 'r1', createdAt: new Date('2026-01-01T00:00:00Z') })], nextCursor: null },
    ];
    const { obs } = await buildModule({ jobRuns });
    const timeline = await obs.getCorrelationTimeline('root-1');
    expect(timeline.summary).toEqual({
      runCount: 1,
      eventCount: 0,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      lastActivityAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('passes tenantId through to both sibling ports', async () => {
    const jobRuns = new FakeJobRunService();
    const events = new FakeEventReadPort();
    const { obs } = await buildModule({ jobRuns, events });
    await obs.getCorrelationTimeline('root-1', 'tenant-x');
    expect((jobRuns.calls[0]!.args[0] as ListJobRunsQuery).tenantId).toBe('tenant-x');
    expect((events.calls[0]!.args[0] as ListEventsQuery).tenantId).toBe('tenant-x');
  });
});
