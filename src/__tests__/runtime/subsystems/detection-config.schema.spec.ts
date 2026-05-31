/**
 * DetectionConfigSchema unit tests (#226-1)
 *
 * Validates the Zod schema that codifies per-entity detection config —
 * field mapping, resolved filters, cursor strategy, and provenance knob.
 * The schema is the canonical source of filter/mapping shape and is
 * imported by both runtime primitives (PollChangeSource et al, future
 * PRs) and the codegen entity-YAML validator.
 *
 * See ADR-033 + decision memo Q4.
 */
import { describe, expect, it } from 'bun:test';
import {
  CURSOR_DIVISIBILITY,
  DetectionConfigSchema,
  FieldMappingSchema,
  isDivisibleCursor,
  ResolvedFilterSchema,
  CursorStrategySchema,
} from '../../../../runtime/subsystems/integration/detection-config.schema';

describe('FieldMappingSchema', () => {
  it('accepts a minimal { source, target } pair', () => {
    expect(
      FieldMappingSchema.parse({ source: 'Id', target: 'external_id' }),
    ).toEqual({ source: 'Id', target: 'external_id' });
  });

  it('accepts an optional transform tag', () => {
    expect(
      FieldMappingSchema.parse({
        source: 'CreatedDate',
        target: 'created_at',
        transform: 'date-iso',
      }),
    ).toEqual({
      source: 'CreatedDate',
      target: 'created_at',
      transform: 'date-iso',
    });
  });

  it('rejects empty source or target', () => {
    expect(
      FieldMappingSchema.safeParse({ source: '', target: 'x' }).success,
    ).toBe(false);
    expect(
      FieldMappingSchema.safeParse({ source: 'x', target: '' }).success,
    ).toBe(false);
  });
});

describe('ResolvedFilterSchema', () => {
  it('accepts a flat-AND filter triple', () => {
    expect(
      ResolvedFilterSchema.parse({
        field: 'StageName',
        op: 'eq',
        value: 'Closed Won',
      }),
    ).toEqual({ field: 'StageName', op: 'eq', value: 'Closed Won' });
  });

  it('accepts every locked operator', () => {
    for (const op of ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(
        ResolvedFilterSchema.safeParse({ field: 'f', op, value: 1 }).success,
      ).toBe(true);
    }
  });

  it('accepts array values for in / nin', () => {
    expect(
      ResolvedFilterSchema.parse({
        field: 'StageName',
        op: 'in',
        value: ['Closed Won', 'Closed Lost'],
      }),
    ).toBeDefined();
  });

  it('rejects unknown operators', () => {
    expect(
      ResolvedFilterSchema.safeParse({ field: 'f', op: 'matches', value: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('CursorStrategySchema', () => {
  it('accepts the system-modstamp variant', () => {
    expect(
      CursorStrategySchema.parse({
        kind: 'systemModstamp',
        field: 'SystemModstamp',
      }),
    ).toEqual({ kind: 'systemModstamp', field: 'SystemModstamp' });
  });

  it('accepts the replay-id variant', () => {
    expect(
      CursorStrategySchema.parse({ kind: 'replayId', field: 'ReplayId' }),
    ).toEqual({ kind: 'replayId', field: 'ReplayId' });
  });

  it('accepts the timestamp variant', () => {
    expect(
      CursorStrategySchema.parse({ kind: 'timestamp', field: 'occurredAt' }),
    ).toEqual({ kind: 'timestamp', field: 'occurredAt' });
  });

  it('accepts the eventId variant (webhook dedup)', () => {
    expect(
      CursorStrategySchema.parse({ kind: 'eventId', field: 'event_id' }),
    ).toEqual({ kind: 'eventId', field: 'event_id' });
  });

  it('accepts the historyId variant (Gmail — atomic, RFC-0003 §3)', () => {
    expect(
      CursorStrategySchema.parse({ kind: 'historyId', field: 'historyId' }),
    ).toEqual({ kind: 'historyId', field: 'historyId' });
  });

  it('accepts the syncToken variant (Calendar — atomic, RFC-0003 §3)', () => {
    expect(
      CursorStrategySchema.parse({ kind: 'syncToken', field: 'nextSyncToken' }),
    ).toEqual({ kind: 'syncToken', field: 'nextSyncToken' });
  });

  it('rejects an unknown kind', () => {
    expect(
      CursorStrategySchema.safeParse({ kind: 'offset', field: 'n' }).success,
    ).toBe(false);
  });
});

describe('cursor divisibility (RFC-0003 §3)', () => {
  it('classifies sortable/monotonic watermarks as divisible', () => {
    expect(isDivisibleCursor('systemModstamp')).toBe(true);
    expect(isDivisibleCursor('timestamp')).toBe(true);
    expect(isDivisibleCursor('replayId')).toBe(true);
  });

  it('classifies opaque vendor tokens as atomic', () => {
    expect(isDivisibleCursor('historyId')).toBe(false);
    expect(isDivisibleCursor('syncToken')).toBe(false);
    expect(isDivisibleCursor('eventId')).toBe(false);
  });

  it('CURSOR_DIVISIBILITY covers every cursor kind exactly', () => {
    const kinds = ['systemModstamp', 'replayId', 'timestamp', 'eventId', 'historyId', 'syncToken'];
    expect(Object.keys(CURSOR_DIVISIBILITY).sort()).toEqual([...kinds].sort());
    // predicate agrees with the map for every kind
    for (const k of kinds) {
      expect(isDivisibleCursor(k as keyof typeof CURSOR_DIVISIBILITY)).toBe(
        CURSOR_DIVISIBILITY[k as keyof typeof CURSOR_DIVISIBILITY],
      );
    }
  });
});

describe('DetectionConfigSchema — modes', () => {
  it('parses a poll-mode config', () => {
    const parsed = DetectionConfigSchema.parse({
      mode: 'poll',
      poll: {
        cursor: { kind: 'systemModstamp', field: 'SystemModstamp' },
      },
      mapping: [{ source: 'Id', target: 'external_id' }],
      filters: [{ field: 'IsDeleted', op: 'eq', value: false }],
    });
    expect(parsed.mode).toBe('poll');
    if (parsed.mode === 'poll') {
      expect(parsed.poll.cursor.kind).toBe('systemModstamp');
      expect(parsed.poll.provenance ?? 'poll').toBe('poll');
    }
  });

  it('parses a poll-mode config with cdc-as-provenance opt-in', () => {
    const parsed = DetectionConfigSchema.parse({
      mode: 'poll',
      poll: {
        cursor: { kind: 'eventId', field: 'id' },
        provenance: 'cdc',
      },
      mapping: [{ source: 'id', target: 'external_id' }],
    });
    expect(parsed.mode).toBe('poll');
    if (parsed.mode === 'poll') {
      expect(parsed.poll.provenance).toBe('cdc');
    }
  });

  it('parses a webhook-mode config', () => {
    const parsed = DetectionConfigSchema.parse({
      mode: 'webhook',
      webhook: {
        eventIdField: 'event_id',
      },
      mapping: [{ source: 'id', target: 'external_id' }],
    });
    expect(parsed.mode).toBe('webhook');
    if (parsed.mode === 'webhook') {
      expect(parsed.webhook.eventIdField).toBe('event_id');
    }
  });

  it('defaults filters to an empty array when omitted', () => {
    const parsed = DetectionConfigSchema.parse({
      mode: 'poll',
      poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
      mapping: [{ source: 'Id', target: 'external_id' }],
    });
    expect(parsed.filters).toEqual([]);
  });

  it('rejects mode mismatched with branch (poll-mode missing poll block)', () => {
    expect(
      DetectionConfigSchema.safeParse({
        mode: 'poll',
        mapping: [{ source: 'Id', target: 'external_id' }],
      }).success,
    ).toBe(false);
  });

  it('rejects mode mismatched with branch (webhook-mode missing webhook block)', () => {
    expect(
      DetectionConfigSchema.safeParse({
        mode: 'webhook',
        mapping: [{ source: 'Id', target: 'external_id' }],
      }).success,
    ).toBe(false);
  });

  it('rejects empty mapping (entity must map at least external_id)', () => {
    expect(
      DetectionConfigSchema.safeParse({
        mode: 'poll',
        poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
        mapping: [],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown mode', () => {
    expect(
      DetectionConfigSchema.safeParse({
        mode: 'stream',
        mapping: [{ source: 'Id', target: 'external_id' }],
      }).success,
    ).toBe(false);
  });
});
