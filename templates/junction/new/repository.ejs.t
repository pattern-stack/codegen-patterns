---
to: "<%= outputPaths.repository %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { JunctionSyncRepository } from '@shared/base-classes/junction-sync-repository';
import type { JunctionSyncConfig } from '@shared/base-classes/junction-sync-repository';
<%_ syncParentImports.forEach((imp) => { _%>
import { <%= imp.table %> } from '<%= imp.importPath %>';
<%_ }); _%>
import { <%= tableVarName %>, type <%= classNames.entity %> } from './<%= name %>.entity';

/**
 * Canonical fields a synced <%= name %> junction write carries (#374). BOTH
 * parent FKs are named by their vendor external ids and resolved STRICTLY in
 * the tx (a missing parent throws → the orchestrator records a failed item and
 * continues). `userId` is run context (no column on the junction).
 */
export interface <%= classNames.entity %>SyncWrite {
<%_ syncWriteFields.forEach((f) => { _%>
  readonly <%= f.name %>: <%- f.tsType %>;
<%_ }); _%>
}

/**
 * Canonical-projected view of a <%= name %> junction row, keyed for the sync
 * differ (#374). `id` is the COMPOSITE externalId (the junction has no
 * surrogate id); the FKs are the LOCAL resolved uuids.
 */
export interface <%= classNames.entity %>SyncProjection {
<%_ syncProjectionFields.forEach((f) => { _%>
  readonly <%= f.name %>: <%- f.tsType %>;
<%_ }); _%>
}

@Injectable()
export class <%= classNames.repository %> extends JunctionSyncRepository<
  <%= classNames.entity %>,
  <%= classNames.entity %>SyncWrite,
  <%= classNames.entity %>SyncProjection
> {
  readonly table = <%= tableVarName %>;

  // Junctions track temporal validity via started_at / ended_at, NOT via
  // deleted_at. is_primary flips replace soft-delete semantics (Q5 resolution).
  protected override readonly behaviors = {
    timestamps: true,
    softDelete: false,
    userTracking: false,
  };

  // Inbound-sync write surface (#374). Both endpoints resolve strictly against
  // the live parent tables; role-bearing junctions conflict on (left,right,role).
  protected readonly syncConfig: JunctionSyncConfig = {
    left: { column: '<%= junctionSyncConfig.leftColumn %>', refTable: <%= junctionSyncConfig.leftRefTable %> },
    right: { column: '<%= junctionSyncConfig.rightColumn %>', refTable: <%= junctionSyncConfig.rightRefTable %> },
    roleColumn: <%- junctionSyncConfig.roleColumn ? `'${junctionSyncConfig.roleColumn}'` : 'null' %>,
  };

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pairing-aware finders — hardcoded in v1 (Q2 resolution: no declarative
  // queries block on junctions; every junction needs exactly these two methods).
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch all junction rows where <%= leftColumn %> matches.
   *
   * Pagination shape: { cursor?, limit? } — canonical per cgp-62 r4.
   * FIXME: align with codegen-patterns#358 pagination shape if it diverges.
   */
  async findBy<%= leftEntityPascal %>Id(
    <%= leftColumnCamel %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<<%= classNames.entity %>[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table.<%= leftColumnCamel %>, <%= leftColumnCamel %>))
      .limit(opts?.limit ?? 100);
    return rows as <%= classNames.entity %>[];
  }

  /**
   * Fetch all junction rows where <%= rightColumn %> matches.
   *
   * Pagination shape: { cursor?, limit? } — canonical per cgp-62 r4.
   * FIXME: align with codegen-patterns#358 pagination shape if it diverges.
   */
  async findBy<%= rightEntityPascal %>Id(
    <%= rightColumnCamel %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<<%= classNames.entity %>[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table.<%= rightColumnCamel %>, <%= rightColumnCamel %>))
      .limit(opts?.limit ?? 100);
    return rows as <%= classNames.entity %>[];
  }

  // Inherited from JunctionSyncRepository (+ BaseRepository):
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
  //   syncUpsertOne, findByExternalIdProjected, softDeleteByExternalId
}
