/**
 * SyncedEntityRepository<TEntity, TSyncWrite, TSyncProjection>
 *
 * Family-specific base for Synced entities (contacts, accounts, opportunities).
 * Adds external ID lookups, user-scoped queries, and the generic inbound-sync
 * write surface (canonical→Drizzle upsert + provider-scoped FK resolution +
 * EAV dual-write seam), driven by the concrete repo's `syncConfig`.
 *
 * The type params default so pre-existing single-param subclasses keep
 * compiling; `pattern: Synced` repos declare all three plus `syncConfig`.
 */
import { and, eq, inArray } from 'drizzle-orm';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import type { DrizzleTx } from '../types/drizzle';
import { BaseRepository } from './base-repository';
import type { SyncUpsertConfig, SyncFkResolver } from './sync-upsert-config';

export abstract class SyncedEntityRepository<
  TEntity,
  TSyncWrite = Partial<TEntity>,
  TSyncProjection = TEntity,
> extends BaseRepository<TEntity> {
  /**
   * Declarative sync write surface. Concrete (`pattern: Synced`) repositories
   * declare this — the template emits it from the entity's fields + FKs.
   */
  protected abstract readonly syncConfig: SyncUpsertConfig;

  /**
   * Find a single entity by its external CRM identifier.
   */
  async findByExternalId(externalId: string): Promise<TEntity | null> {
    const rows = await this.baseQuery()
      .where(eq(this.table['externalId'], externalId))
      .limit(1);
    return (rows[0] as TEntity) ?? null;
  }

  /**
   * Find multiple entities by external CRM identifiers.
   */
  async findManyByExternalIds(externalIds: string[]): Promise<TEntity[]> {
    if (externalIds.length === 0) return [];
    const rows = await this.baseQuery()
      .where(inArray(this.table['externalId'], externalIds));
    return rows as TEntity[];
  }

  /**
   * Find all entities owned by a specific user.
   */
  async findAllByUserId(userId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['userId'], userId));
    return rows as TEntity[];
  }

  // ==========================================================================
  // Inbound sync (#374) — canonical→Drizzle write + provider-scoped FK
  // resolution + EAV dual-write seam, all inside a SINGLE transaction.
  // Driven entirely by `this.syncConfig`; the per-entity shape lives there.
  // ==========================================================================

  /**
   * Upsert ONE entity by its `(provider, externalId)` identity, in a single
   * transaction:
   *   1. resolve each `syncConfig.fkResolvers` FK (provider-scoped). Strict
   *      resolvers throw on unresolved; non-strict leave the column null.
   *   2. insert-or-update the canonical columns via `onConflictDoUpdate` on the
   *      `conflictTarget`. Resolved FKs are only written into `set` when
   *      non-null this run (no-clobber).
   *   3. EAV dual-write of `write.fields` via `writeCustomFields` when
   *      `syncConfig.eav` and the bag is non-empty (same tx).
   *
   * Idempotent: a second call with the same identity updates in place. Returns
   * the canonical projection (so the orchestrator records `local_id`).
   *
   * @param write     canonical fields + parent external ids + custom-field bag
   * @param provider  adapter/provider label persisted + used to scope lookups
   * @param tx        optional outer transaction; when omitted we open our own
   */
  async syncUpsertOne(
    write: TSyncWrite,
    provider: string,
    tx?: DrizzleTx,
  ): Promise<TSyncProjection> {
    const cfg = this.syncConfig;
    const w = write as Record<string, unknown>;

    const run = async (db: DrizzleTx): Promise<TSyncProjection> => {
      // 1. FK resolution (provider-scoped). Strict → throw; else opportunistic null.
      const resolvedFks: Record<string, string | null> = {};
      for (const fk of cfg.fkResolvers) {
        resolvedFks[fk.column] = await this.resolveFk(db, fk, w[fk.writeKey], provider);
      }

      // 2. Canonical → Drizzle insert-or-update by the conflict target.
      const now = new Date();
      const copyThrough: Record<string, unknown> = {};
      for (const col of cfg.writeColumns) copyThrough[col] = w[col];

      const values: Record<string, unknown> = {
        externalId: w['externalId'],
        provider,
        ...copyThrough,
        ...resolvedFks,
        ...(this.behaviors.timestamps ? { updatedAt: now } : {}),
      };

      // `set` excludes the identity (externalId/provider). Resolved FKs are
      // only written when non-null this run — never clobber a previously
      // resolved parent with null on a later run that dropped the ref.
      const set: Record<string, unknown> = {
        ...copyThrough,
        ...(this.behaviors.timestamps ? { updatedAt: now } : {}),
      };
      for (const fk of cfg.fkResolvers) {
        if (resolvedFks[fk.column] !== null) set[fk.column] = resolvedFks[fk.column];
      }

      const rows = await db
        .insert(this.table)
        .values(values as never)
        .onConflictDoUpdate({
          target: cfg.conflictTarget.map((c) => this.table[c]),
          set: set as never,
        })
        .returning();

      const saved = rows[0] as Record<string, unknown>;

      // 3. EAV dual-write seam — same tx. No-op unless the entity opts in.
      const fields = w['fields'] as Record<string, unknown> | undefined;
      if (cfg.eav && fields && Object.keys(fields).length > 0) {
        await this.writeCustomFields(
          db,
          saved['id'] as string,
          w['userId'] as string,
          fields,
        );
      }

      return this.toProjection(saved as TEntity);
    };

    return tx ? run(tx) : this.db.transaction((t) => run(t));
  }

  /**
   * Canonical-projected lookup by external id (differ-ready). Returns `null`
   * when no local row exists. Provider-scoped so a HubSpot id can't match a
   * Salesforce row.
   */
  async findByExternalIdProjected(
    externalId: string,
    provider: string,
  ): Promise<TSyncProjection | null> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.table['provider'], provider),
          eq(this.table['externalId'], externalId),
        ),
      )
      .limit(1);
    const row = rows[0] as TEntity | undefined;
    return row ? this.toProjection(row) : null;
  }

  /**
   * Sync "delete" by external id, provider-scoped. When `softDelete: true`,
   * sets `deletedAt`. When `softDelete: false`, tombstone-by-clearing: null out
   * `external_id`/`provider` so the row no longer matches future inbound
   * changes while preserving local-id references. Returns `{ id }` or `null`.
   */
  async softDeleteByExternalId(
    externalId: string,
    provider: string,
    tx?: DrizzleTx,
  ): Promise<{ id: string } | null> {
    const db = this.runner(tx);
    const set = this.syncConfig.softDelete
      ? { deletedAt: new Date(), updatedAt: new Date() }
      : { externalId: null, provider: null, updatedAt: new Date() };
    const rows = await db
      .update(this.table)
      .set(set as never)
      .where(
        and(
          eq(this.table['provider'], provider),
          eq(this.table['externalId'], externalId),
        ),
      )
      .returning({ id: this.table['id'] });
    return rows[0] ? { id: rows[0].id as string } : null;
  }

  /**
   * Batch sync upsert — concretizes the former abstract stub. Delegates to
   * `syncUpsertOne` per input inside one transaction. Inputs are raw partial
   * rows: provider is read from each input's own `provider` column; rows
   * missing `externalId`/`provider` are skipped.
   */
  async syncUpsert(inputs: Array<Partial<TEntity>>): Promise<TEntity[]> {
    if (inputs.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const out: TEntity[] = [];
      for (const input of inputs) {
        const rec = input as Record<string, unknown>;
        if (!rec['externalId'] || !rec['provider']) continue;
        const proj = await this.syncUpsertOne(
          input as unknown as TSyncWrite,
          rec['provider'] as string,
          tx,
        );
        const id = (proj as Record<string, unknown>)['id'] as string;
        const row = await tx
          .select()
          .from(this.table)
          .where(eq(this.table['id'], id))
          .limit(1);
        out.push(row[0] as TEntity);
      }
      return out;
    });
  }

  /**
   * Project a raw row to the canonical differ shape — a generic pick over
   * `syncConfig.projectionColumns`. Override only for synthesized projections
   * (e.g. junctions); entities use this verbatim.
   */
  protected toProjection(row: TEntity): TSyncProjection {
    const r = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const col of this.syncConfig.projectionColumns) out[col] = r[col];
    return out as TSyncProjection;
  }

  /**
   * EAV dual-write seam (#374, live path lands in #124). No-op by default;
   * `eav: true` entities emit a concrete override that injects
   * `FieldValueService` and delegates to `upsertFieldsTransactional` so the
   * dual-write joins the same tx (`db`). Kept as an explicit hook so the base
   * stays portable (the FieldValueService dependency is eav-only).
   */
  protected async writeCustomFields(
    _db: DrizzleTx,
    _entityId: string,
    _userId: string,
    _fields: Record<string, unknown>,
  ): Promise<void> {
    // Intentionally empty until the entity opts into EAV.
  }

  /**
   * Resolve one FK from a parent external id (provider-scoped). `self` resolves
   * against `this.table`. Strict resolvers throw when unresolved; non-strict
   * return null. A null/absent write value short-circuits to null.
   */
  private async resolveFk(
    db: DrizzleTx,
    fk: SyncFkResolver,
    rawExternalId: unknown,
    provider: string,
  ): Promise<string | null> {
    const parentExternalId = rawExternalId as string | null | undefined;
    if (!parentExternalId) {
      if (fk.strict) {
        throw new Error(
          `${this.constructor.name}.syncUpsertOne: missing required parent ` +
            `external id for '${fk.column}' (writeKey '${fk.writeKey}')`,
        );
      }
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refTable: PgTableWithColumns<any> =
      fk.refTable === 'self' ? this.table : fk.refTable;
    const rows = await db
      .select({ id: refTable['id'] })
      .from(refTable)
      .where(
        and(
          eq(refTable['provider'], provider),
          eq(refTable['externalId'], parentExternalId),
        ),
      )
      .limit(1);
    const id = (rows[0]?.id as string | undefined) ?? null;
    if (id === null && fk.strict) {
      throw new Error(
        `${this.constructor.name}.syncUpsertOne: unresolved parent ` +
          `'${parentExternalId}' (provider '${provider}') for '${fk.column}' — ` +
          `parent not synced yet`,
      );
    }
    return id;
  }

  /**
   * Find entities visible to a user (ownership + sharing rules).
   * Concrete repositories must implement with visibility logic.
   */
  async findVisibleByUserId(_userId: string): Promise<TEntity[]> {
    throw new Error('findVisibleByUserId not implemented — override in concrete repository');
  }
}
