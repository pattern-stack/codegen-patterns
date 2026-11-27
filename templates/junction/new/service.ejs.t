---
to: "<%= outputPaths.service %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
<% if (!plainWiring) { -%>
import { Injectable, Inject, Optional } from '@nestjs/common';
<% } -%>
import { WithAnalytics } from '<%= withAnalyticsImport %>';
<% if (!plainWiring) { -%>
import { EVENT_BUS } from '<%= drizzleTokenImport %>';
<% } -%>
import { BaseService } from '<%= baseServiceImport %>';
import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import type { <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
import { <%= leftRepositoryClass %> } from '<%= leftRepoImportFromJunction %>';
import type { <%= leftEntityPascal %> } from '<%= leftEntityImportFromJunction %>';
import { <%= rightRepositoryClass %> } from '<%= rightRepoImportFromJunction %>';
import type { <%= rightEntityPascal %> } from '<%= rightEntityImportFromJunction %>';

/**
 * Pick of the link-side mutable fields that callers may supply when
 * attaching. Subset of `<%= classNames.entity %>` minus the two FK columns
 * (those come from the method args).
 */
export type <%= entityNamePascal %>LinkInput = globalThis.Partial<
  globalThis.Pick<<%= classNames.entity %>,
    <%- linkInputKeys %>
  >
><% if (linkInputRequiredKeys) { %> & globalThis.Pick<<%= classNames.entity %>, <%- linkInputRequiredKeys %>><% } %>;

<% if (!plainWiring) { -%>
@Injectable()
<% } -%>
export class <%= classNames.service %> extends WithAnalytics(
  BaseService<<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= name %>';
<% if (!plainWiring) { -%>

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;
<% } -%>

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
    link<%= linkInputRequiredKeys ? '' : '?' %>: <%= entityNamePascal %>LinkInput,
  ): Promise<<%= classNames.entity %>> {
    return this.create({
      <%= leftColumnCamel %>: <%= leftEntityCamel %>Id,
      <%= rightColumnCamel %>: <%= rightEntityCamel %>Id,
      ...(link ?? {}),
    } as unknown as globalThis.Partial<<%= classNames.entity %>>);
  }

  /**
   * Remove the link between `<%= leftEntityCamel %>Id` and `<%= rightEntityCamel %>Id`:
   * every row of the pair (every role, when the junction has one). No-op if the
   * pair isn't linked. Addressed by the pair, since a junction table has no `id`
   * column; the 'deleted' event's id is `<left>:<right>`.
   */
  async detach(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
  ): Promise<void> {
    const removed = await this.repository.deleteLink(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id);
    if (removed > 0) this.emitKeyedLifecycle('deleted', `${<%= leftEntityCamel %>Id}:${<%= rightEntityCamel %>Id}`);
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
      const byId = new globalThis.Map(targets.map((t) => [(t as any).id, t]));
      return links.map((link) => ({
        entity: byId.get((link as any).<%= rightColumnCamel %>)! as <%= rightEntityPascal %>,
        link,
      }));
    } else {
      const links = await this.repository.findBy<%= rightEntityPascal %>Id(anchorId, opts);
      const targetIds = links.map((l) => (l as any).<%= leftColumnCamel %> as string);
      const targets = await this.<%= leftEntityCamel %>Repo.findByIds(targetIds);
      const byId = new globalThis.Map(targets.map((t) => [(t as any).id, t]));
      return links.map((link) => ({
        entity: byId.get((link as any).<%= leftColumnCamel %>)! as <%= leftEntityPascal %>,
        link,
      }));
    }
  }
<%_ if (isPrimary) { _%>

  /**
   * Mark the (`<%= leftEntityCamel %>Id`, `<%= rightEntityCamel %>Id`) link
   * as `is_primary: true`: every row of the pair (every role, when the junction
   * has one), since being primary is the pair's. Demoting other rows on the same
   * side is the caller's concern in v1; future leaves may add transactional demotion.
   */
  async setPrimary(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
  ): Promise<void> {
    const rows = await this.repository.updateLink(
      <%= leftEntityCamel %>Id,
      <%= rightEntityCamel %>Id,
      { isPrimary: true } as unknown as globalThis.Partial<<%= classNames.entity %>>,
    );
    for (const row of rows) {
      this.emitKeyedLifecycle('updated', `${<%= leftEntityCamel %>Id}:${<%= rightEntityCamel %>Id}`, row);
    }
  }
<%_ } _%>

  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete
}
