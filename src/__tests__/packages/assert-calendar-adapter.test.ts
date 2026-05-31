/**
 * Unit tests for assertCalendarAdapter (interaction lift).
 *
 * Imports the helper from the '@pattern-stack/codegen-calendar/testing' subpath
 * (proving that export resolves) and the CalendarPort type +
 * NO_CALENDAR_CAPABILITIES from the package root. Fakes are plain objects cast
 * to CalendarPort — the L1 types are type-only / erased, so these run without
 * codegen built or linked.
 */

import { describe, it, expect } from 'bun:test';
import { assertCalendarAdapter } from '@pattern-stack/codegen-calendar/testing';
import {
  NO_CALENDAR_CAPABILITIES,
  type CalendarCapabilities,
  type CalendarPort,
} from '@pattern-stack/codegen-calendar';

/** Minimal fake of the per-entity changeSources contributions map. */
function fakeChangeSources(names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((n) => [n, { label: `fake-source:${n}` }]),
  );
}

/** Build a CalendarPort fake; override any slot per test. */
function makeAdapter(
  overrides: Partial<Record<keyof CalendarPort, unknown>> = {},
  caps: Partial<CalendarCapabilities> = {},
): CalendarPort {
  const capabilities: CalendarCapabilities = {
    ...NO_CALENDAR_CAPABILITIES,
    ...caps,
  };
  const base: Record<string, unknown> = {
    auth: { label: 'fake-auth' },
    changeSources: fakeChangeSources(capabilities.entities as string[]),
    capabilities,
    ...overrides,
  };
  return base as unknown as CalendarPort;
}

// Regression guard (RFC-0003 R3): the post-E0 emitted adapter shape must satisfy
// CalendarPort — auth + capabilities + changeSources, NO `sources` registry.
const _postE0Shape: CalendarPort = {
  auth: { label: 'x' } as CalendarPort['auth'],
  capabilities: NO_CALENDAR_CAPABILITIES,
  changeSources: {},
};
void _postE0Shape;

function failures(fn: () => void): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError);
    return (err as AggregateError).errors.map((e) => (e as Error).message);
  }
  throw new Error('expected assertCalendarAdapter to throw');
}

describe('assertCalendarAdapter', () => {
  it('passes a conforming adapter whose entities all resolve', () => {
    const adapter = makeAdapter({}, { entities: ['meeting'] });
    expect(() => assertCalendarAdapter(adapter)).not.toThrow();
  });

  it('passes a no-entity adapter', () => {
    expect(() => assertCalendarAdapter(makeAdapter())).not.toThrow();
  });

  it('throws when auth is missing', () => {
    const msgs = failures(() =>
      assertCalendarAdapter(makeAdapter({ auth: undefined })),
    );
    expect(msgs).toContain('CalendarPort.auth missing');
  });

  it('throws when changeSources is missing', () => {
    const msgs = failures(() =>
      assertCalendarAdapter(makeAdapter({ changeSources: undefined })),
    );
    expect(msgs).toContain('CalendarPort.changeSources missing');
  });

  it("throws when caps.entities lists an entity changeSources can't resolve", () => {
    const adapter = makeAdapter(
      { changeSources: {} },
      { entities: ['meeting'] },
    );
    const msgs = failures(() => assertCalendarAdapter(adapter));
    expect(msgs).toContain(
      "caps.entities lists 'meeting' but changeSources['meeting'] is missing",
    );
  });
});
