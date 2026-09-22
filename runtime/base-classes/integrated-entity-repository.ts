/**
 * IntegratedEntityRepository<TEntity, TTable, TIntegrationWrite, TIntegrationProjection>
 *
 * Family-specific base for Integrated entities (contacts, accounts, opportunities).
 * Adds external ID lookups, user-scoped queries, and the generic inbound-integration
 * write surface (canonical→Drizzle upsert + provider-scoped FK resolution +
 * EAV dual-write seam), driven by the concrete repo's `integrationConfig`.
 *
 * `TTable` is the concrete `pgTable(...)` type (REL-0); the write/projection
 * params default to the entity, so a non-integrated subclass names only the
 * first two. `pattern: Integrated` repos declare all four plus `integrationConfig`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { AnyRelations } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleTx } from '../types/drizzle';
import { BaseRepository } from './base-repository';
import { column } from './table-columns';
import type { IntegrationUpsertConfig, IntegrationFkResolver } from './integration-upsert-config';

export abstract class IntegratedEntityRepository<
  TEntity,
  TTable extends PgTable,
  TRelations extends AnyRelations,
  TIntegrationWrite = Partial<TEntity>,
  TIntegrationProjection = TEntity,
> extends BaseRepository<TEntity, TTable, TRelations> {
  /**
   * Declarative integration write surface. Concrete (`pattern: Integrated`) repositories
   * declare this — the template emits it from the entity's fields + FKs.
   */
  protected abstract readonly integrationConfig: IntegrationUpsertConfig;

  /**
   * Find a single entity by its external CRM identifier.
   */
  async findByExternalId(externalId: string): Promise<TEntity | null> {
    const rows = await this.baseQuery(eq(this.col('externalId'), externalId))
      .limit(1);
    return (rows[0] as TEntity) ?? null;
  }

  /**
   * Find multiple entities by external CRM identifiers.
   */
  async findManyByExternalIds(externalIds: string[]): Promise<TEntity[]> {
    if (externalIds.length === 0) return [];
    const rows = await this.baseQuery(inArray(this.col('externalId'), externalIds));
    return rows as TEntity[];
  }

  /**
   * Find all entities owned by a specific user.
   */
  async findAllByUserId(userId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery(eq(this.col('userId'), userId));
    return rows as TEntity[];
  }

  // ==========================================================================
  // Inbound integration (#374) — canonical→Drizzle write + provider-scoped FK
  // resolution + EAV dual-write seam, all inside a SINGLE transaction.
  // Driven entirely by `this.integrationConfig`; the per-entity shape lives there.
  // ==========================================================================

  /**
   * Upsert ONE entity by its `(provider, externalId)` identity, in a single
   * transaction:
   *   1. resolve each `integrationConfig.fkResolvers` FK (provider-scoped). Strict
   *      resolvers throw on unresolved; non-strict leave the column null.
   *   2. insert-or-update the canonical columns via `onConflictDoUpdate` on the
   *      `conflictTarget`. Resolved FKs are only written into `set` when
   *      non-null this run (no-clobber).
   *   3. EAV dual-write of `write.fields` via `writeCustomFields` when
   *      `integrationConfig.eav` and the bag is non-empty (same tx).
   *
   * Idempotent: a second call with the same identity updates in place. Returns
   * the canonical projection (so the orchestrator records `local_id`).
   *
   * @param write     canonical fields + parent external ids + custom-field bag
   * @param provider  adapter/provider label persisted + used to scope lookups
   * @param tx        optional outer transaction; when omitted we open our own
   */
  async integrationUpsertOne(
    write: TIntegrationWrite,
    provider: string,
    tx?: DrizzleTx,
  ): Promise<TIntegrationProjection> {
    const cfg = this.integrationConfig;
    const w = write as Record<string, unknown>;

    const run = async (db: DrizzleTx): Promise<TIntegrationProjection> => {
      // 1. FK resolution (provider-scoped). Strict → throw; else opportunistic null.
      const resolvedFks: Record<string, string | null> = {};
      for (const fk of cfg.fkResolvers) {
        resolvedFks[fk.column] = await this.resolveFk(db, fk, w[fk.writeKey], provider);
      }

      // 2. Canonical → Drizzle insert-or-update by the conflict target.
      const now = new Date();
      const copyThrough: Record<string, unknown> = {};
      for (const col of cfg.writeColumns) copyThrough[col] = w[col];

      const values: Record<string, unknown> = this.stampTenant({
        externalId: w['externalId'],
        provider,
        ...copyThrough,
        ...resolvedFks,
        ...(this.behaviors.timestamps ? { updatedAt: now } : {}),
      });

      // `set` excludes the identity (externalId/provider) AND `tenantId`, which
      // is never in `writeColumns` — a conflicting row's owning tenant is never
      // rewritten. Resolved FKs are only written when non-null this run — never
      // clobber a previously resolved parent with null on a later run that
      // dropped the ref.
      const set: Record<string, unknown> = {
        ...copyThrough,
        ...(this.behaviors.timestamps ? { updatedAt: now } : {}),
      };
      for (const fk of cfg.fkResolvers) {
        if (resolvedFks[fk.column] !== null) set[fk.column] = resolvedFks[fk.column];
      }

      const rows = await db
        .insert(this.tableRef)
        .values(values)
        .onConflictDoUpdate({
          target: this.conflictTarget(cfg.conflictTarget),
          set,
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
  ): Promise<TIntegrationProjection | null> {
    const rows = await this.db
      .select()
      .from(this.tableRef)
      // `scopeAnd` WITHOUT `{ softDelete }` — the differ must still see a
      // soft-deleted row to decide what changed — but WITH the user and tenant
      // guards, which a raw statement would otherwise skip entirely.
      .where(
        this.scopeAnd(
          and(
            eq(this.col('provider'), provider),
            eq(this.col('externalId'), externalId),
          ),
        ),
      )
      .limit(1);
    const row = rows[0] as TEntity | undefined;
    return row ? this.toProjection(row) : null;
  }

  /**
   * Integration "delete" by external id, provider-scoped. When `softDelete: true`,
   * sets `deletedAt`. When `softDelete: false`, tombstone-by-clearing: null out
   * `external_id`/`provider` so the row no longer matches future inbound
   * changes while preserving local-id references. Returns `{ id }` or `null`.
   */
  async softDeleteByExternalId(
    externalId: string,
    provider: string,
    tx?: DrizzleTx,
  ): Promise<{ id: string } | null> {
    // Same class as `delete()` by id: inside `withAllTenants()` the tenant
    // predicate is dropped, so this would tombstone whichever tenant owns that
    // `(provider, external_id)`. A sync that means to act on a tenant must say
    // which one, with `withTenantScope`.
    this.assertTenantWritable('softDeleteByExternalId');
    const db = this.runner(tx);
    const set = this.integrationConfig.softDelete
      ? { deletedAt: new Date(), updatedAt: new Date() }
      : { externalId: null, provider: null, updatedAt: new Date() };
    const rows = await db
      .update(this.tableRef)
      .set(set)
      .where(
        this.scopeAnd(
          and(
            eq(this.col('provider'), provider),
            eq(this.col('externalId'), externalId),
          ),
        ),
      )
      .returning({ id: this.col('id') });
    return rows[0] ? { id: rows[0].id as string } : null;
  }

  /**
   * Batch integration upsert — concretizes the former abstract stub. Delegates to
   * `integrationUpsertOne` per input inside one transaction. Inputs are raw partial
   * rows: provider is read from each input's own `provider` column; rows
   * missing `externalId`/`provider` are skipped.
   */
  async integrationUpsert(inputs: Array<Partial<TEntity>>): Promise<TEntity[]> {
    if (inputs.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const out: TEntity[] = [];
      for (const input of inputs) {
        const rec = input as Record<string, unknown>;
        if (!rec['externalId'] || !rec['provider']) continue;
        const proj = await this.integrationUpsertOne(
          input as unknown as TIntegrationWrite,
          rec['provider'] as string,
          tx,
        );
        const id = (proj as Record<string, unknown>)['id'] as string;
        const row = await tx
          .select()
          .from(this.tableRef)
          .where(this.scopeAnd(eq(this.col('id'), id)))
          .limit(1);
        out.push(row[0] as TEntity);
      }
      return out;
    });
  }

  /**
   * Resolve the `ON CONFLICT` target columns, prefixing `tenant_id` when this
   * repository is tenant-scoped (ADR-042 / TEN-1 §5.1).
   *
   * This is the write-side half of isolation, and the one `scopeAnd()` cannot
   * reach: an upsert's conflict target decides WHICH ROW gets updated before
   * any WHERE is considered. Without the prefix, tenant B's sync would UPDATE
   * tenant A's row whenever the two share an `external_id` — a cross-tenant
   * write, strictly worse than a read leak.
   *
   * The generated `integrationConfig.conflictTarget` already carries
   * `'tenantId'` for a tenant-scoped entity (one declaration, per charter I1);
   * this method is the runtime backstop that makes a hand-written config safe
   * too, and it never double-prefixes.
   *
   * The matching unique constraint is emitted as
   * `unique(...).on(tenantId, provider, externalId).nullsNotDistinct()` — the
   * `NULLS NOT DISTINCT` matters because the tenant column is nullable, and
   * Postgres otherwise treats every null-tenant row as distinct, so the
   * conflict would never fire and the upsert would insert duplicates.
   */
  protected conflictTarget(declared: readonly string[]): PgColumn[] {
    const names = this.behaviors.tenantScoped && !declared.includes('tenantId')
      ? ['tenantId', ...declared]
      : [...declared];
    return names.map((c) => this.col(c));
  }

  /**
   * Project a raw row to the canonical differ shape — a generic pick over
   * `integrationConfig.projectionColumns`. Override only for synthesized projections
   * (e.g. junctions); entities use this verbatim.
   */
  protected toProjection(row: TEntity): TIntegrationProjection {
    const r = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const col of this.integrationConfig.projectionColumns) out[col] = r[col];
    return out as TIntegrationProjection;
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
    fk: IntegrationFkResolver,
    rawExternalId: unknown,
    provider: string,
  ): Promise<string | null> {
    const parentExternalId = rawExternalId as string | null | undefined;
    if (!parentExternalId) {
      if (fk.strict) {
        throw new Error(
          `${this.constructor.name}.integrationUpsertOne: missing required parent ` +
            `external id for '${fk.column}' (writeKey '${fk.writeKey}')`,
        );
      }
      return null;
    }
    const refTable: PgTable =
      fk.refTable === 'self' ? this.tableRef : fk.refTable;
    const isSelf = fk.refTable === 'self';
    const owner = `${this.constructor.name}.integrationConfig.fkResolvers['${fk.column}']`;
    const identity = and(
      eq(column(refTable, 'provider', owner), provider),
      eq(column(refTable, 'externalId', owner), parentExternalId),
    );
    // A SELF resolver reads THIS table, so the repository's own guards apply and
    // a tenant-scoped hierarchy cannot resolve a parent in another tenant.
    //
    // A CROSS-TABLE resolver cannot be scoped here: whether the PARENT entity is
    // tenant-scoped is a fact about the parent's YAML, and recovering it by
    // inspecting the parent table's columns would be introspecting generated
    // output to learn what a declaration already says (charter I1). It travels
    // as generated data in REL-1's manifest — see TEN-1 §8 and #702. Until then
    // a cross-tenant parent external id resolves to that parent's local id: the
    // CHILD row is still written in the caller's tenant and still reads back
    // scoped, but the FK it carries can point across the boundary.
    const rows = await db
      .select({ id: column(refTable, 'id', owner) })
      .from(refTable)
      .where(isSelf ? this.scopeAnd(identity) : identity)
      .limit(1);
    const id = (rows[0]?.id as string | undefined) ?? null;
    if (id === null && fk.strict) {
      throw new Error(
        `${this.constructor.name}.integrationUpsertOne: unresolved parent ` +
          `'${parentExternalId}' (provider '${provider}') for '${fk.column}' — ` +
          `parent not integrated yet`,
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
