/**
 * OBS-LIST-1 — unit tests for the observability combiner's row-level reads:
 * `listEvents` and `getCorrelationTimeline`. (JOBS-3 dropped `listJobRuns`
 * and the timeline's job runs: `JobsService` is the operator view of runs.)
 *
 * Three axes:
 *   1. Delegation — listEvents forwards the query verbatim to the events read
 *      port and returns its page unchanged.
 *   2. Missing-port degradation — when EVENT_READ_PORT is absent, the read
 *      returns an empty page; the timeline degrades to zero counts (ADR-025 §61).
 *   3. getCorrelationTimeline — the events sharing a rootRunId, ascending,
 *      drained via the keyset cursor, with a summary.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';

import {
  OBSERVABILITY,
  type EventPage,
  type IObservability,
} from '../../../../runtime/subsystems/observability';
import { ObservabilityService } from '../../../../runtime/subsystems/observability/observability.service';

import { EVENT_READ_PORT } from '../../../../runtime/subsystems/events/events.tokens';
import type {
  EventPage as EP,
  EventSummary,
  IEventReadPort,
  ListEventsQuery,
} from '../../../../runtime/subsystems/events/event-read.protocol';

// ─── Fakes ─────────────────────────────────────────────────────────────────

type Call = { method: string; args: readonly unknown[] };

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

async function buildModule(opts: { events?: FakeEventReadPort }) {
  const providers: import('@nestjs/common').Provider[] = [
    ObservabilityService,
    { provide: OBSERVABILITY, useExisting: ObservabilityService },
  ];
  if (opts.events) providers.push({ provide: EVENT_READ_PORT, useValue: opts.events });
  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const obs = moduleRef.get(OBSERVABILITY) as IObservability;
  return { moduleRef, obs };
}

// ─── listEvents delegation ─────────────────────────────────────

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
  it('lists the events sharing the rootRunId, ascending, with a summary', async () => {
    const events = new FakeEventReadPort();
    events.pages = [
      {
        items: [
          eventSummary({ id: 'evt-2', occurredAt: new Date('2026-01-01T00:00:05Z') }),
          eventSummary({ id: 'evt-1', occurredAt: new Date('2026-01-01T00:00:03Z') }),
        ],
        nextCursor: null,
      },
    ];
    const { obs } = await buildModule({ events });

    const timeline = await obs.getCorrelationTimeline('root-1');

    expect(timeline.rootRunId).toBe('root-1');
    expect(timeline.entries.map((e) => e.event.id)).toEqual(['evt-1', 'evt-2']);
    expect(timeline.summary).toEqual({
      eventCount: 2,
      startedAt: new Date('2026-01-01T00:00:03Z'),
      lastActivityAt: new Date('2026-01-01T00:00:05Z'),
    });
    expect(events.calls[0]!.args[0]).toMatchObject({ rootRunId: 'root-1' });
  });

  it('drains multi-page results via the keyset cursor', async () => {
    const events = new FakeEventReadPort();
    events.pages = [
      { items: [eventSummary({ id: 'e1', occurredAt: new Date('2026-01-01T00:00:00Z') })], nextCursor: 'C1' },
      { items: [eventSummary({ id: 'e2', occurredAt: new Date('2026-01-01T00:00:01Z') })], nextCursor: null },
    ];
    const { obs } = await buildModule({ events });

    const timeline = await obs.getCorrelationTimeline('root-1');
    expect(timeline.summary.eventCount).toBe(2);
    expect(events.calls).toHaveLength(2);
    expect((events.calls[1]!.args[0] as ListEventsQuery).cursor).toBe('C1');
  });

  it('degrades to an empty timeline when the events read port is absent', async () => {
    const { obs } = await buildModule({});
    expect(await obs.getCorrelationTimeline('root-1')).toEqual({
      rootRunId: 'root-1',
      entries: [],
      summary: { eventCount: 0, startedAt: null, lastActivityAt: null },
    });
  });

  it('passes tenantId through to the events read port', async () => {
    const events = new FakeEventReadPort();
    const { obs } = await buildModule({ events });
    await obs.getCorrelationTimeline('root-1', 'tenant-x');
    expect((events.calls[0]!.args[0] as ListEventsQuery).tenantId).toBe('tenant-x');
  });
});
