/**
 * JunctionSyncRepository<TEntity, TSyncWrite, TSyncProjection>
 *
 * Base for junction repos that participate in inbound sync (#374). A junction's
 * sync identity is the tuple `(leftId, rightId[, role])` — there is no native
 * `external_id`/`provider` column, so the sync seam's externalId is a COMPOSITE
 * string `<leftExternalId>::<rightExternalId>[::<role>]` (see the static
 * build/parse helpers below).
 *
 * Both parent FKs are resolved STRICTLY in the write path (a missing parent
 * throws → the orchestrator records a failed item and continues). As of #372
 * role-bearing junctions carry a unique constraint over `(left, right, role)`,
 * so the upsert uses `onConflictDoUpdate` (not the legacy select-then-write).
 * Role-less junctions conflict on `(left, right)`.
 */
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import type { DrizzleTx } from '../types/drizzle';
import { BaseRepository } from './base-repository';

export interface JunctionSyncConfig {
  /** Left endpoint: local FK column (camel) + strict parent table. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  left: { column: string; refTable: PgTableWithColumns<any> };
  /** Right endpoint: local FK column (camel) + strict parent table. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  right: { column: string; refTable: PgTableWithColumns<any> };
  /** Role column (camel), or null for a role-less (2-part composite) junction. */
  roleColumn: string | null;
}

export abstract class JunctionSyncRepository<
  TEntity,
  TSyncWrite,
  TSyncProjection,
> extends BaseRepository<TEntity> {
  /**
   * Declarative junction sync surface. Concrete repos declare this — the
   * template emits it with live parent-table handles.
   */
  protected abstract readonly syncConfig: JunctionSyncConfig;

  /**
   * Upsert ONE junction row by its composite identity, in a single transaction:
   *   1. resolve the REQUIRED left FK (provider-scoped) — STRICT: missing → throws;
   *   2. resolve the REQUIRED right FK (provider-scoped) — STRICT: missing → throws;
   *   3. insert-or-update on the `(left, right[, role])` conflict target.
   *
   * Idempotent. Returns the composite externalId as the projection `id`.
   *
   * @param write     parent external ids (`<left>ExternalId`/`<right>ExternalId`)
   *                  + optional `role` + `userId`
   * @param provider  adapter/provider label used to scope the parent lookups
   * @param tx        optional outer transaction; when omitted we open our own
   */
  async syncUpsertOne(
    write: TSyncWrite,
    provider: string,
    tx?: DrizzleTx,
  ): Promise<TSyncProjection> {
    const cfg = this.syncConfig;
    const w = write as Record<string, unknown>;
    const leftWriteKey = `${cfg.left.column.replace(/Id$/, '')}ExternalId`;
    const rightWriteKey = `${cfg.right.column.replace(/Id$/, '')}ExternalId`;

    const run = async (db: DrizzleTx): Promise<TSyncProjection> => {
      const leftId = await this.resolveStrict(
        db, cfg.left.refTable, w[leftWriteKey] as string, provider, cfg.left.column,
      );
      const rightId = await this.resolveStrict(
        db, cfg.right.refTable, w[rightWriteKey] as string, provider, cfg.right.column,
      );

      const now = new Date();
      const role = cfg.roleColumn ? (w['role'] as unknown) : undefined;
      const values: Record<string, unknown> = {
        [cfg.left.column]: leftId,
        [cfg.right.column]: rightId,
        ...(cfg.roleColumn ? { [cfg.roleColumn]: role } : {}),
        ...(this.behaviors.timestamps ? { updatedAt: now } : {}),
      };
      const target = cfg.roleColumn
        ? [this.table[cfg.left.column], this.table[cfg.right.column], this.table[cfg.roleColumn]]
        : [this.table[cfg.left.column], this.table[cfg.right.column]];

      const rows = await db
        .insert(this.table)
        .values(values as never)
        .onConflictDoUpdate({
          target,
          set: { ...(this.behaviors.timestamps ? { updatedAt: now } : {}) } as never,
        })
        .returning();

      const saved = rows[0] as Record<string, unknown>;
      return this.toProjection(saved as TEntity, w, provider);
    };

    return tx ? run(tx) : this.db.transaction((t) => run(t));
  }

  /**
   * Canonical-projected lookup by the COMPOSITE externalId, differ-ready. Parses
   * the composite, resolves BOTH parents NON-throwing (→ null), then selects by
   * the identity tuple. Returns `null` on malformed composite / unresolved
   * parent / no row (a missing "before" side is a create from the differ's view).
   */
  async findByExternalIdProjected(
    externalId: string,
    provider: string,
  ): Promise<TSyncProjection | null> {
    const cfg = this.syncConfig;
    const parsed = parseCompositeExternalId(externalId, cfg.roleColumn !== null);
    if (!parsed) return null;

    const leftId = await this.resolveLoose(this.db, cfg.left.refTable, parsed.left, provider);
    if (leftId === null) return null;
    const rightId = await this.resolveLoose(this.db, cfg.right.refTable, parsed.right, provider);
    if (rightId === null) return null;

    const rows = await this.db
      .select()
      .from(this.table)
      .where(this.identityWhere(leftId, rightId, parsed.role))
      .limit(1);
    const row = rows[0] as TEntity | undefined;
    if (!row) return null;

    const w: Record<string, unknown> = {
      [`${cfg.left.column.replace(/Id$/, '')}ExternalId`]: parsed.left,
      [`${cfg.right.column.replace(/Id$/, '')}ExternalId`]: parsed.right,
      ...(cfg.roleColumn ? { role: parsed.role } : {}),
      userId: '',
    };
    return this.toProjection(row, w, provider);
  }

  /**
   * Hard-delete the junction by composite externalId. Junctions have no
   * `deleted_at` and no external-linkage columns to clear, so a sync "delete"
   * removes the row. Resolves both parents NON-throwing, then deletes by the
   * identity tuple. Returns the composite id, or `null` when nothing matched.
   */
  async softDeleteByExternalId(
    externalId: string,
    provider: string,
    tx?: DrizzleTx,
  ): Promise<{ id: string } | null> {
    const cfg = this.syncConfig;
    const parsed = parseCompositeExternalId(externalId, cfg.roleColumn !== null);
    if (!parsed) return null;
    const db = this.runner(tx);

    const leftId = await this.resolveLoose(db, cfg.left.refTable, parsed.left, provider);
    if (leftId === null) return null;
    const rightId = await this.resolveLoose(db, cfg.right.refTable, parsed.right, provider);
    if (rightId === null) return null;

    const rows = await db
      .delete(this.table)
      .where(this.identityWhere(leftId, rightId, parsed.role))
      .returning({ id: this.table[cfg.left.column] });
    return rows[0] ? { id: externalId } : null;
  }

  /**
   * Project a raw junction row to the differ shape. `id` is the COMPOSITE
   * externalId (the junction has no surrogate id). Override to widen the
   * projection beyond the identity tuple (the template emits a concrete
   * `toProjection` carrying the role + local FKs + timestamps).
   */
  protected toProjection(
    _row: TEntity,
    write: Record<string, unknown>,
    _provider: string,
  ): TSyncProjection {
    const cfg = this.syncConfig;
    const leftExt = write[`${cfg.left.column.replace(/Id$/, '')}ExternalId`] as string;
    const rightExt = write[`${cfg.right.column.replace(/Id$/, '')}ExternalId`] as string;
    const role = cfg.roleColumn ? (write['role'] as string) : undefined;
    return { id: buildCompositeExternalId(leftExt, rightExt, role) } as TSyncProjection;
  }

  /** Build the identity WHERE clause `(left, right[, role])`. */
  private identityWhere(leftId: string, rightId: string, role: string | undefined) {
    const cfg = this.syncConfig;
    const conds = [
      eq(this.table[cfg.left.column], leftId),
      eq(this.table[cfg.right.column], rightId),
    ];
    if (cfg.roleColumn && role !== undefined) {
      conds.push(eq(this.table[cfg.roleColumn], role));
    }
    return and(...conds);
  }

  /** Resolve a parent id (provider-scoped), throwing when unresolved. */
  private async resolveStrict(
    db: DrizzleTx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refTable: PgTableWithColumns<any>,
    parentExternalId: string,
    provider: string,
    column: string,
  ): Promise<string> {
    const id = await this.resolveLoose(db, refTable, parentExternalId, provider);
    if (!id) {
      throw new Error(
        `${this.constructor.name}.syncUpsertOne: unresolved parent ` +
          `'${parentExternalId}' (provider '${provider}') for '${column}' — ` +
          `parent not synced yet`,
      );
    }
    return id;
  }

  /** Resolve a parent id (provider-scoped), returning null when unresolved. */
  private async resolveLoose(
    db: DrizzleTx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refTable: PgTableWithColumns<any>,
    parentExternalId: string | null | undefined,
    provider: string,
  ): Promise<string | null> {
    if (!parentExternalId) return null;
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
    return (rows[0]?.id as string | undefined) ?? null;
  }
}

// ============================================================================
// Composite externalId — the junction sync seam's deterministic identity.
//
// Format: `<leftExternalId>::<rightExternalId>[::<role>]`
//   e.g. `hubspot:42::hubspot:99::employee`  (role-bearing)
//        `hubspot:42::hubspot:99`            (role-less)
//
// Vendor-prefixed ids use a SINGLE colon, so `::` is an unambiguous delimiter.
// Kept static in the base (replacing the per-repo free functions) so every
// junction's lookups + its ChangeSource share one definition.
// ============================================================================

/**
 * Build the composite externalId from the two parent external ids (+ role when
 * the junction is role-bearing).
 */
export function buildCompositeExternalId(
  leftExternalId: string,
  rightExternalId: string,
  role?: string,
): string {
  return role !== undefined
    ? `${leftExternalId}::${rightExternalId}::${role}`
    : `${leftExternalId}::${rightExternalId}`;
}

/**
 * Parse a composite externalId. `withRole` selects the expected part count
 * (3 when role-bearing, else 2). Returns `null` when the shape doesn't match
 * or any part is empty.
 */
export function parseCompositeExternalId(
  externalId: string,
  withRole: boolean,
): { left: string; right: string; role: string | undefined } | null {
  const parts = externalId.split('::');
  const expected = withRole ? 3 : 2;
  if (parts.length !== expected || parts.some((p) => p.length === 0)) return null;
  return {
    left: parts[0] as string,
    right: parts[1] as string,
    role: withRole ? (parts[2] as string) : undefined,
  };
}
