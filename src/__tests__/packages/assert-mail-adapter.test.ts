/**
 * Unit tests for assertMailAdapter (interaction lift).
 *
 * Imports the helper from the '@pattern-stack/codegen-mail/testing' subpath and
 * the MailPort type + NO_MAIL_CAPABILITIES from the package root. Fakes are
 * plain objects cast to MailPort — the L1 types are type-only / erased.
 */

import { describe, it, expect } from 'bun:test';
import { assertMailAdapter } from '@pattern-stack/codegen-mail/testing';
import {
  NO_MAIL_CAPABILITIES,
  type MailCapabilities,
  type MailPort,
} from '@pattern-stack/codegen-mail';

function fakeSources(names: string[]) {
  const set = new Set(names);
  return {
    has: (n: string) => set.has(n),
    get: () => {
      throw new Error('not needed for conformance');
    },
    entities: () => [...set],
  };
}

function makeAdapter(
  overrides: Partial<Record<keyof MailPort, unknown>> = {},
  caps: Partial<MailCapabilities> = {},
): MailPort {
  const capabilities: MailCapabilities = { ...NO_MAIL_CAPABILITIES, ...caps };
  const base: Record<string, unknown> = {
    auth: { label: 'fake-auth' },
    sources: fakeSources(capabilities.entities as string[]),
    capabilities,
    ...overrides,
  };
  return base as unknown as MailPort;
}

function failures(fn: () => void): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError);
    return (err as AggregateError).errors.map((e) => (e as Error).message);
  }
  throw new Error('expected assertMailAdapter to throw');
}

describe('assertMailAdapter', () => {
  it('passes a conforming adapter whose entities all resolve', () => {
    const adapter = makeAdapter({}, { entities: ['email'] });
    expect(() => assertMailAdapter(adapter)).not.toThrow();
  });

  it('passes a no-entity adapter', () => {
    expect(() => assertMailAdapter(makeAdapter())).not.toThrow();
  });

  it('throws when auth is missing', () => {
    const msgs = failures(() =>
      assertMailAdapter(makeAdapter({ auth: undefined })),
    );
    expect(msgs).toContain('MailPort.auth missing');
  });

  it('throws when sources is missing', () => {
    const msgs = failures(() =>
      assertMailAdapter(makeAdapter({ sources: undefined })),
    );
    expect(msgs).toContain('MailPort.sources missing');
  });

  it("throws when caps.entities lists an entity sources can't resolve", () => {
    const adapter = makeAdapter(
      { sources: fakeSources([]) },
      { entities: ['email'] },
    );
    const msgs = failures(() => assertMailAdapter(adapter));
    expect(msgs).toContain(
      "caps.entities lists 'email' but sources.has('email') is false",
    );
  });
});
