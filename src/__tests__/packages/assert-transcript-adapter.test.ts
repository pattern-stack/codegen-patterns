/**
 * Unit tests for assertTranscriptAdapter (interaction lift).
 *
 * Imports the helper from the '@pattern-stack/codegen-transcript/testing'
 * subpath and the TranscriptPort type + NO_TRANSCRIPT_CAPABILITIES from the
 * package root. Fakes are plain objects cast to TranscriptPort — the L1 types
 * are type-only / erased.
 */

import { describe, it, expect } from 'bun:test';
import { assertTranscriptAdapter } from '@pattern-stack/codegen-transcript/testing';
import {
  NO_TRANSCRIPT_CAPABILITIES,
  type TranscriptCapabilities,
  type TranscriptPort,
} from '@pattern-stack/codegen-transcript';

function fakeChangeSources(names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((n) => [n, { label: `fake-source:${n}` }]),
  );
}

function makeAdapter(
  overrides: Partial<Record<keyof TranscriptPort, unknown>> = {},
  caps: Partial<TranscriptCapabilities> = {},
): TranscriptPort {
  const capabilities: TranscriptCapabilities = {
    ...NO_TRANSCRIPT_CAPABILITIES,
    ...caps,
  };
  const base: Record<string, unknown> = {
    auth: { label: 'fake-auth' },
    changeSources: fakeChangeSources(capabilities.entities as string[]),
    capabilities,
    ...overrides,
  };
  return base as unknown as TranscriptPort;
}

// Regression guard (RFC-0003 R3): the post-E0 emitted adapter shape must satisfy
// TranscriptPort — auth + capabilities + changeSources, NO `sources` registry.
const _postE0Shape: TranscriptPort = {
  auth: { label: 'x' } as TranscriptPort['auth'],
  capabilities: NO_TRANSCRIPT_CAPABILITIES,
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
  throw new Error('expected assertTranscriptAdapter to throw');
}

describe('assertTranscriptAdapter', () => {
  it('passes a conforming adapter whose entities all resolve', () => {
    const adapter = makeAdapter({}, { entities: ['transcript'] });
    expect(() => assertTranscriptAdapter(adapter)).not.toThrow();
  });

  it('passes a no-entity adapter', () => {
    expect(() => assertTranscriptAdapter(makeAdapter())).not.toThrow();
  });

  it('throws when auth is missing', () => {
    const msgs = failures(() =>
      assertTranscriptAdapter(makeAdapter({ auth: undefined })),
    );
    expect(msgs).toContain('TranscriptPort.auth missing');
  });

  it('throws when changeSources is missing', () => {
    const msgs = failures(() =>
      assertTranscriptAdapter(makeAdapter({ changeSources: undefined })),
    );
    expect(msgs).toContain('TranscriptPort.changeSources missing');
  });

  it("throws when caps.entities lists an entity changeSources can't resolve", () => {
    const adapter = makeAdapter(
      { changeSources: {} },
      { entities: ['transcript'] },
    );
    const msgs = failures(() => assertTranscriptAdapter(adapter));
    expect(msgs).toContain(
      "caps.entities lists 'transcript' but changeSources['transcript'] is missing",
    );
  });
});
