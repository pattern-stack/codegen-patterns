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

function fakeChangeSources(names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((n) => [n, { label: `fake-source:${n}` }]),
  );
}

function makeAdapter(
  overrides: Partial<Record<keyof MailPort, unknown>> = {},
  caps: Partial<MailCapabilities> = {},
): MailPort {
  const capabilities: MailCapabilities = { ...NO_MAIL_CAPABILITIES, ...caps };
  const base: Record<string, unknown> = {
    auth: { label: 'fake-auth' },
    changeSources: fakeChangeSources(capabilities.entities as string[]),
    capabilities,
    ...overrides,
  };
  return base as unknown as MailPort;
}

// Regression guard (RFC-0003 R3): the post-E0 emitted adapter shape — auth +
// capabilities + changeSources, and NO `sources` registry — must satisfy
// MailPort. If the port ever drifts back to requiring a `sources` registry
// back-edge (the E0-broken state), this stops compiling.
const _postE0Shape: MailPort = {
  auth: { label: 'x' } as MailPort['auth'],
  capabilities: NO_MAIL_CAPABILITIES,
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

  it('throws when changeSources is missing', () => {
    const msgs = failures(() =>
      assertMailAdapter(makeAdapter({ changeSources: undefined })),
    );
    expect(msgs).toContain('MailPort.changeSources missing');
  });

  it("throws when caps.entities lists an entity changeSources can't resolve", () => {
    const adapter = makeAdapter(
      { changeSources: {} },
      { entities: ['email'] },
    );
    const msgs = failures(() => assertMailAdapter(adapter));
    expect(msgs).toContain(
      "caps.entities lists 'email' but changeSources['email'] is missing",
    );
  });
});
