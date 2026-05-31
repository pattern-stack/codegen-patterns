/**
 * Unit tests for the entity-keyed change-source registry (Track C · C7, #336).
 *
 * Covers the L1 memory impl: `get` resolves a registered source, `get` throws
 * `UnknownEntityError` (with the available-entities list) on a miss, and `has`
 * / `entities()` report membership. Imports through the integration subsystem
 * barrel to lock the public export surface.
 */

import { describe, it, expect } from 'bun:test';
import {
  MemoryEntityChangeSourceRegistry,
  UnknownEntityError,
  ENTITY_CHANGE_SOURCE_REGISTRY,
  type IChangeSource,
  type IEntityChangeSourceRegistry,
} from '../../../../runtime/subsystems/integration';

/** Minimal IChangeSource fake — the registry never calls listChanges. */
function fakeSource<T = unknown>(label: string): IChangeSource<T> {
  return {
    label,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *listChanges() {
      /* no changes */
    },
  };
}

function makeRegistry(
  names: string[],
): { registry: IEntityChangeSourceRegistry; sources: Map<string, IChangeSource<unknown>> } {
  const sources = new Map<string, IChangeSource<unknown>>(
    names.map((n) => [n, fakeSource(`poll-${n}`)]),
  );
  return { registry: new MemoryEntityChangeSourceRegistry(sources), sources };
}

describe('MemoryEntityChangeSourceRegistry', () => {
  it('get() resolves a registered source', () => {
    const { registry, sources } = makeRegistry(['account', 'contact']);
    expect(registry.get('account')).toBe(sources.get('account')!);
    expect(registry.get('account').label).toBe('poll-account');
  });

  it('get() is generic — returns the source typed to the requested T', () => {
    interface Account {
      id: string;
    }
    const sources = new Map<string, IChangeSource<unknown>>([
      ['account', fakeSource<Account>('poll-account')],
    ]);
    const registry = new MemoryEntityChangeSourceRegistry(sources);
    const source = registry.get<Account>('account');
    expect(source.label).toBe('poll-account');
  });

  it('get() throws UnknownEntityError listing available entities on a miss', () => {
    const { registry } = makeRegistry(['account', 'contact']);
    expect(() => registry.get('deal')).toThrow(UnknownEntityError);
    try {
      registry.get('deal');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownEntityError);
      expect((err as Error).name).toBe('UnknownEntityError');
      expect((err as Error).message).toBe(
        "No change source registered for entity 'deal'. Available: account, contact",
      );
    }
  });

  it('has() reports membership', () => {
    const { registry } = makeRegistry(['account']);
    expect(registry.has('account')).toBe(true);
    expect(registry.has('contact')).toBe(false);
  });

  it('entities() lists all registered entity names in insertion order', () => {
    const { registry } = makeRegistry(['account', 'contact', 'lead']);
    expect(registry.entities()).toEqual(['account', 'contact', 'lead']);
  });

  it('entities() on an empty registry is empty; get() lists nothing available', () => {
    const { registry } = makeRegistry([]);
    expect(registry.entities()).toEqual([]);
    expect(() => registry.get('account')).toThrow(
      "No change source registered for entity 'account'. Available: ",
    );
  });

  it('exposes the DI token as a string constant', () => {
    expect(ENTITY_CHANGE_SOURCE_REGISTRY).toBe('ENTITY_CHANGE_SOURCE_REGISTRY');
  });
});
