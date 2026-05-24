---
to: "<%= outputPaths.repository %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { BaseRepository } from '@shared/base-classes/base-repository';
import { <%= tableVarName %>, type <%= classNames.entity %> } from './<%= name %>.entity';

@Injectable()
export class <%= classNames.repository %> extends BaseRepository<<%= classNames.entity %>> {
  readonly table = <%= tableVarName %>;

  // Junctions track temporal validity via started_at / ended_at, NOT via
  // deleted_at. is_primary flips replace soft-delete semantics (Q5 resolution).
  protected override readonly behaviors = {
    timestamps: true,
    softDelete: false,
    userTracking: false,
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

  // Inherited from BaseRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
}
