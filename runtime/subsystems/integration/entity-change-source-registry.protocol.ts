/**
 * Integration subsystem — entity-keyed change-source registry (port)
 *
 * `IEntityChangeSourceRegistry` resolves an `IChangeSource<T>` by entity name.
 * It generalizes today's per-entity DI tokens (`ACCOUNT_POLL_FETCH_REGISTRY`,
 * `CONTACT_POLL_FETCH_REGISTRY`, …) into one entity-keyed registry, so the L3
 * composing port (`<Surface>Port`, Track C C6) can be entity-agnostic at the
 * type level instead of enumerating entities (epic #328 locked decision #5).
 *
 * This lives in L1 (the integration subsystem) rather than in a per-surface
 * package because the same shape applies across surfaces — CRM (`account`,
 * `contact`, `deal`), Mail (`email`, `thread`, `label`), Transcript
 * (`transcript`, `speaker`, `utterance`), Meeting (`meeting`, `attendee`).
 * Cross-surface plumbing belongs at L1 (epic #328 locked decision #6).
 *
 * Scope (Track C · C7): this is purely the L1 type + memory impl. Codegen does
 * NOT yet emit this registry, and the existing per-entity tokens keep emitting
 * unchanged — the retarget (and the per-entity-token deprecation) is Track D
 * D3/D4 (RFC-0001 §3/§8).
 *
 * See #336 (this issue), #328 (parent epic), RFC-0001 §3 (the registry
 * contract Track D emits the wiring for).
 */

import type { IChangeSource } from './integration-change-source.protocol';

/**
 * Entity-keyed resolver for change sources. The orchestrator (and the L3
 * surface port) consume this, agnostic to whether a source came from a
 * hand-written adapter or a configured `PollChangeSource<T>`.
 */
export interface IEntityChangeSourceRegistry {
  /**
   * Resolve a change source for a given entity name.
   * Throws {@link UnknownEntityError} if the entity isn't registered.
   */
  get<T = unknown>(entityName: string): IChangeSource<T>;

  /** True if the entity is registered. */
  has(entityName: string): boolean;

  /** List all entity names this registry serves. */
  entities(): readonly string[];
}

/**
 * Thrown by {@link IEntityChangeSourceRegistry.get} when no source is
 * registered for the requested entity. The message enumerates the available
 * entities so a misconfiguration (typo'd entity name, missing adapter
 * contribution) is diagnosable from the error alone.
 */
export class UnknownEntityError extends Error {
  constructor(entity: string, available: readonly string[]) {
    super(
      `No change source registered for entity '${entity}'. Available: ${available.join(', ')}`,
    );
    this.name = 'UnknownEntityError';
  }
}
