/**
 * SyncUpsertConfig + SyncFkResolver
 *
 * Declarative description of an entity's inbound-sync write surface, consumed
 * by `SyncedEntityRepository.syncUpsertOne` / `findByExternalIdProjected` /
 * `softDeleteByExternalId` / `toProjection`. Each `pattern: Synced` repository
 * declares a concrete `syncConfig: SyncUpsertConfig` (emitted by the template),
 * the same idiom as `behaviors: BehaviorConfig`.
 *
 * Named `SyncUpsertConfig` (not `SyncConfig`) to avoid colliding with the sync
 * subsystem's `DetectionConfig`/`SyncConfig` surface.
 *
 * The generic upsert separates three column roles:
 *   - identity      (`conflictTarget`) — only in `values`, never in `set`
 *   - copy-through  (`writeColumns`)   — in both `values` and `set`
 *   - resolved FK   (`fkResolvers`)    — conditional in `set` (no-clobber)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';

/**
 * Resolves a local FK column from a parent's external id, provider-scoped.
 *
 * The base does `SELECT id FROM <refTable> WHERE (provider, externalId) =
 * (provider, write[writeKey])`. `refTable === 'self'` resolves to `this.table`
 * (self-FK). `strict: true` throws when the parent is unresolved (junction
 * posture); falsy leaves the column null this run (opportunistic, entity
 * posture).
 */
export interface SyncFkResolver {
  /** Local FK column — camel key into `this.table`, e.g. `'parentAccountId'`. */
  column: string;
  /** Key on `TSyncWrite` carrying the parent external id (see Decision 4). */
  writeKey: string;
  /** Parent table to resolve against; `'self'` → `this.table`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refTable: PgTableWithColumns<any> | 'self';
  /** true = throw on unresolved (junction); falsy = opportunistic null (entity). */
  strict?: boolean;
}

export interface SyncUpsertConfig {
  /** Camel keys into `this.table` forming the conflict target, e.g. `['provider', 'externalId']`. */
  conflictTarget: string[];
  /**
   * Canonical columns copied verbatim write→values/set (camel). EXCLUDES
   * `externalId`, `provider`, FK columns, and behavior-managed timestamps.
   */
  writeColumns: string[];
  /** Conditional, provider-scoped FK resolvers. */
  fkResolvers: SyncFkResolver[];
  /** Columns picked into the projection (camel), incl. id/externalId/timestamps. */
  projectionColumns: string[];
  /** When true, `syncUpsertOne` calls `writeCustomFields` for a non-empty `fields` bag. */
  eav: boolean;
  /** When true, deletes set `deletedAt`; when false, tombstone-by-clearing external_id/provider. */
  softDelete: boolean;
}
