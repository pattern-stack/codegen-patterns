/**
 * Unit tests for assertCrmAdapter (Track C · C6, #337).
 *
 * Imports the helper from the '@pattern-stack/codegen-crm/testing' subpath
 * (proving that export resolves) and the CrmPort type + NO_CRM_CAPABILITIES
 * from the package root. Fakes are plain objects cast to CrmPort — no value is
 * imported from @pattern-stack/codegen (the L1 types are type-only / erased),
 * so these run without codegen built or linked.
 */

import { describe, it, expect } from 'bun:test';
import { assertCrmAdapter } from '@pattern-stack/codegen-crm/testing';
import {
  NO_CRM_CAPABILITIES,
  type CrmPort,
  type CrmCapabilities,
} from '@pattern-stack/codegen-crm';

/** Minimal fake of IEntityChangeSourceRegistry over a name set. */
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

/** Build a CrmPort fake; override any slot/capability per test. */
function makeAdapter(
  overrides: Partial<Record<keyof CrmPort, unknown>> = {},
  caps: Partial<CrmCapabilities> = {},
): CrmPort {
  const capabilities: CrmCapabilities = { ...NO_CRM_CAPABILITIES, ...caps };
  const base: Record<string, unknown> = {
    auth: { label: 'fake-auth' },
    sources: fakeSources(capabilities.entities as string[]),
    fields: { list: async () => [] },
    picklists: { values: async () => [] },
    associations: { list: async () => [] },
    capabilities,
    ...overrides,
  };
  return base as unknown as CrmPort;
}

function failures(fn: () => void): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError);
    return (err as AggregateError).errors.map((e) => (e as Error).message);
  }
  throw new Error('expected assertCrmAdapter to throw');
}

describe('assertCrmAdapter — conforming adapters', () => {
  it('passes a fully-implementing adapter with matching capabilities', () => {
    const adapter = makeAdapter({}, {
      fieldDefinitions: true,
      picklists: true,
      associations: true,
      entities: ['account', 'contact', 'opportunity'],
    });
    expect(() => assertCrmAdapter(adapter)).not.toThrow();
  });

  it('passes a no-capability adapter (all flags false, no entities)', () => {
    // respectCapabilities checks that present ports are declared — so a minimal
    // conforming adapter omits the undeclared L2 ports.
    const adapter = makeAdapter({
      fields: undefined,
      picklists: undefined,
      associations: undefined,
    });
    expect(() => assertCrmAdapter(adapter)).not.toThrow();
  });
});

describe('assertCrmAdapter — failure modes', () => {
  it('throws when auth is missing', () => {
    const msgs = failures(() => assertCrmAdapter(makeAdapter({ auth: undefined })));
    expect(msgs).toContain('CrmPort.auth missing');
  });

  it('throws when sources is missing', () => {
    const msgs = failures(() =>
      assertCrmAdapter(makeAdapter({ sources: undefined })),
    );
    expect(msgs).toContain('CrmPort.sources missing');
  });

  it('throws when a declared capability has no matching port', () => {
    const adapter = makeAdapter({ fields: undefined }, { fieldDefinitions: true });
    const msgs = failures(() => assertCrmAdapter(adapter));
    expect(msgs).toContain('caps.fieldDefinitions=true but CrmPort.fields missing');
  });

  it("throws when caps.entities lists an entity sources can't resolve", () => {
    // entities includes 'lead' but the registry only knows account/contact.
    const adapter = makeAdapter(
      { sources: fakeSources(['account', 'contact']) },
      { entities: ['account', 'contact', 'lead'] },
    );
    const msgs = failures(() => assertCrmAdapter(adapter));
    expect(msgs).toContain(
      "caps.entities lists 'lead' but sources.has('lead') is false",
    );
  });

  it('respectCapabilities: flags a present port whose capability is not declared', () => {
    // fields present but fieldDefinitions=false (default).
    const adapter = makeAdapter({}, { picklists: true, associations: true });
    const msgs = failures(() => assertCrmAdapter(adapter));
    expect(msgs).toContain(
      'CrmPort.fields present but caps.fieldDefinitions is not true',
    );
  });

  it('respectCapabilities:false suppresses the present-but-undeclared check', () => {
    const adapter = makeAdapter({}, { picklists: true, associations: true });
    // fields/picklists/associations all present; only picklists+associations declared.
    expect(() =>
      assertCrmAdapter(adapter, { respectCapabilities: false }),
    ).not.toThrow();
  });

  it('aggregates multiple failures into one AggregateError', () => {
    const adapter = makeAdapter(
      { auth: undefined, fields: undefined, sources: fakeSources([]) },
      { fieldDefinitions: true, entities: ['lead'] },
    );
    const msgs = failures(() => assertCrmAdapter(adapter));
    expect(msgs).toContain('CrmPort.auth missing');
    expect(msgs).toContain('caps.fieldDefinitions=true but CrmPort.fields missing');
    expect(msgs).toContain(
      "caps.entities lists 'lead' but sources.has('lead') is false",
    );
    expect(msgs.length).toBeGreaterThanOrEqual(3);
  });
});
