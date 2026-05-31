/**
 * Integration subsystem — in-memory entity-change-source registry
 *
 * Default `IEntityChangeSourceRegistry` backed by a `Map<entityName, source>`.
 * Track D's codegen-emitted aggregator folds per-provider adapter
 * contributions into one of these and binds it under
 * `ENTITY_CHANGE_SOURCE_REGISTRY` (RFC-0001 §3); tests and simple consumers
 * construct it directly.
 *
 * See {@link ./entity-change-source-registry.protocol} for the contract and
 * #336 for scope.
 */

import type { IChangeSource } from './integration-change-source.protocol';
import {
  type IEntityChangeSourceRegistry,
  UnknownEntityError,
} from './entity-change-source-registry.protocol';

export class MemoryEntityChangeSourceRegistry
  implements IEntityChangeSourceRegistry
{
  constructor(private readonly sources: Map<string, IChangeSource<unknown>>) {}

  get<T = unknown>(name: string): IChangeSource<T> {
    const source = this.sources.get(name);
    if (!source) {
      throw new UnknownEntityError(name, [...this.sources.keys()]);
    }
    return source as IChangeSource<T>;
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  entities(): readonly string[] {
    return [...this.sources.keys()];
  }
}
