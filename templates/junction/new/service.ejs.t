---
to: "<%= outputPaths.service %>"
force: true
---
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { <%= classNames.repository %> } from './<%= name %>.repository';
import type { <%= classNames.entity %> } from './<%= name %>.entity';
import { <%= leftRepositoryClass %> } from '<%= leftRepoImportFromJunction %>';
import type { <%= leftEntityPascal %> } from '<%= leftEntityImportFromJunction %>';
import { <%= rightRepositoryClass %> } from '<%= rightRepoImportFromJunction %>';
import type { <%= rightEntityPascal %> } from '<%= rightEntityImportFromJunction %>';

/**
 * Pick of the link-side mutable fields that callers may supply when
 * attaching. Subset of `<%= classNames.entity %>` minus the two FK columns
 * (those come from the method args).
 */
export type <%= entityNamePascal %>LinkInput = Partial<
  Pick<<%= classNames.entity %>,
    'isPrimary'<% if (temporal) { %> | 'startedAt' | 'endedAt'<% } %><% if (sourced) { %> | 'sourcedFrom' | 'confidence' | 'matchedAt'<% } %><% if (hasRole) { %> | 'role'<% } %>
  >
>;

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  BaseService<<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= name %>';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: <%= classNames.repository %>,
    private readonly <%= leftEntityCamel %>Repo: <%= leftRepositoryClass %>,
    private readonly <%= rightEntityCamel %>Repo: <%= rightRepositoryClass %>,
  ) {
    super(repository);
  }

  // Pairing-aware pass-throughs — mirror the repo's two finders so use-cases
  // and #60's fan-out methods both delegate through the service layer, keeping
  // analytics/events instrumentation uniform (per relationship's service.ejs.t).

  /**
   * Fetch all junction rows for a given <%= leftColumn %>.
   */
  async findBy<%= leftEntityPascal %>Id(
    <%= leftColumnCamel %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<<%= classNames.entity %>[]> {
    return this.repository.findBy<%= leftEntityPascal %>Id(<%= leftColumnCamel %>, opts);
  }

  /**
   * Fetch all junction rows for a given <%= rightColumn %>.
   */
  async findBy<%= rightEntityPascal %>Id(
    <%= rightColumnCamel %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<<%= classNames.entity %>[]> {
    return this.repository.findBy<%= rightEntityPascal %>Id(<%= rightColumnCamel %>, opts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CGP-60 — canonical fan-out methods
  // Mirrored, paginated, composed `{ entity, link }` shape. Always emitted
  // on the junction service; parent-side `attach<Right>` / `addTo<Left>` /
  // etc. inject templates delegate here. `list` is implemented with two
  // single-table queries (no Drizzle `with:`).
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a junction row linking a <%= leftEntity %> and a <%= rightEntity %>.
   * Returns the persisted row.
   *
   * **Idempotency:** NOT idempotent at the service layer in v1. A duplicate
   * pair raises the DB-level composite-PK unique-constraint error from the
   * underlying repository's `create`. Callers requiring idempotency should
   * either check existence via `findBy<%= leftEntityPascal %>Id` + filter,
   * or wrap the call in try/catch on the unique-violation error. A future
   * leaf may add a transactional check-then-create here if a consumer
   * surfaces the need (track as a follow-up if so).
   */
  async attach(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
    link?: <%= entityNamePascal %>LinkInput,
  ): Promise<<%= classNames.entity %>> {
    return this.create({
      <%= leftColumnCamel %>: <%= leftEntityCamel %>Id,
      <%= rightColumnCamel %>: <%= rightEntityCamel %>Id,
      ...(link ?? {}),
    } as unknown as Partial<<%= classNames.entity %>>);
  }

  /**
   * Remove the junction row linking `<%= leftEntityCamel %>Id` and
   * `<%= rightEntityCamel %>Id`. No-op if no row exists.
   */
  async detach(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
  ): Promise<void> {
    const links = await this.repository.findBy<%= leftEntityPascal %>Id(<%= leftEntityCamel %>Id);
    const match = links.find(
      (l) => (l as any).<%= rightColumnCamel %> === <%= rightEntityCamel %>Id,
    );
    if (match) {
      await this.delete((match as any).id ?? `${<%= leftEntityCamel %>Id}:${<%= rightEntityCamel %>Id}`);
    }
  }

  /**
   * List the targets associated with one side of the junction, composed as
   * `{ entity, link }`. Implementation: one repo call for the links, one
   * `findByIds` call for the targets — no SQL JOIN. Cursor pagination by
   * right-entity `id` (matches CGP-358 has_many shape; time-ordered cursor
   * is deferred per spec Open Q3).
   */
  async listAssoc(
    side: 'left' | 'right',
    anchorId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: <%= leftEntityPascal %> | <%= rightEntityPascal %>; link: <%= classNames.entity %> }>> {
    if (side === 'left') {
      const links = await this.repository.findBy<%= leftEntityPascal %>Id(anchorId, opts);
      const targetIds = links.map((l) => (l as any).<%= rightColumnCamel %> as string);
      const targets = await this.<%= rightEntityCamel %>Repo.findByIds(targetIds);
      const byId = new Map(targets.map((t) => [(t as any).id, t]));
      return links.map((link) => ({
        entity: byId.get((link as any).<%= rightColumnCamel %>)! as <%= rightEntityPascal %>,
        link,
      }));
    } else {
      const links = await this.repository.findBy<%= rightEntityPascal %>Id(anchorId, opts);
      const targetIds = links.map((l) => (l as any).<%= leftColumnCamel %> as string);
      const targets = await this.<%= leftEntityCamel %>Repo.findByIds(targetIds);
      const byId = new Map(targets.map((t) => [(t as any).id, t]));
      return links.map((link) => ({
        entity: byId.get((link as any).<%= leftColumnCamel %>)! as <%= leftEntityPascal %>,
        link,
      }));
    }
  }

  /**
   * Mark the (`<%= leftEntityCamel %>Id`, `<%= rightEntityCamel %>Id`) row
   * as `is_primary: true`. Demoting other rows on the same side is the
   * caller's concern in v1; future leaves may add transactional demotion.
   */
  async setPrimary(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
  ): Promise<void> {
    const links = await this.repository.findBy<%= leftEntityPascal %>Id(<%= leftEntityCamel %>Id);
    const match = links.find(
      (l) => (l as any).<%= rightColumnCamel %> === <%= rightEntityCamel %>Id,
    );
    if (match) {
      await this.update(
        (match as any).id ?? `${<%= leftEntityCamel %>Id}:${<%= rightEntityCamel %>Id}`,
        { isPrimary: true } as unknown as Partial<<%= classNames.entity %>>,
      );
    }
  }

  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete
}
