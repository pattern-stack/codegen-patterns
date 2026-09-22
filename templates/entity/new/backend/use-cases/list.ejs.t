---
to: "<%= outputPaths.listUseCase %>"
force: true
---
<%- generatedBanner %>
import { Injectable } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { buildPage, resolveListQuery, type ListQuery, type Page } from '<%= paginationImport %>';
import type { SortTerm } from '<%= baseRepositoryImport %>';
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';
import { <%= entityNamePlural %><% if (!includes) { %>, type <%= classNames.entity %><% } %> } from '../<%= entityFileStem %>.entity';
<% if (includes) { -%>
import type {
  <%= classNames.entity %>Include,
  <%= classNames.entity %>NoInclude,
  <%= classNames.entity %>Result,
} from '../<%= entityFileStem %>.repository';
<% } -%>

/**
 * Paginated list use-case for <%= entityNamePlural %> (pagination-by-default).
 *
 * Composes `service.list({ where, limit, offset, sort })` + `service.count(where)`
 * into a `Page<<%- classNames.entity %>>` envelope. Defaults: page 1,
<% if (hasTimestamps) { -%>
 * pageSize 50 (max 200), sort `created_at desc, id desc`. `total`/`pageCount`
<% } else { -%>
 * pageSize 50 (max 200), sort `id desc` — <%= entityNamePlural %> declares no
 * `timestamps` behavior, so there is no `created_at` to sort by; the uuid
 * primary key is already a total order, which is what the tie-break is for.
 * `total`/`pageCount`
<% } -%>
 * reflect the (optionally filtered) set, so pagination composes with where
 * filters orthogonally — it works fully unfiltered too.
 *
<% if (hasTimestamps) { -%>
 * v1 ENGINE = OFFSET. `nextCursor` is computed from the last row and emitted
 * (contract-stable), but cursor-REQUEST honoring (keyset seek) is DEFERRED:
 * `resolved.cursor` is accepted and ignored here. The keyset swap belongs in
 * the marked seam below — fetch by `WHERE (created_at, id) < decodeCursor(cursor)`
 * instead of `offset` — and is otherwise invisible to the controller/UI.
<% } else { -%>
 * v1 ENGINE = OFFSET, and `nextCursor` is always null here: the cursor encodes
 * `(created_at, id)`, which this entity has no `created_at` for. Add the
 * `timestamps` behavior to the YAML if you want cursor paging.
<% } -%>
 */
@Injectable()
export class <%= classNames.listUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

<% if (includes) { -%>
  /**
   * `include` is a typed include tree the controller already resolved against the
   * route's allowlist (REL-2 §5); an internal caller passes one directly. Every
   * hop of it is scoped by the relations manifest, so pagination composes with a
   * nested read without widening what the reader can see.
   */
  async execute<TWith extends <%= classNames.entity %>Include = <%= classNames.entity %>NoInclude>(
    query?: ListQuery,
    include?: TWith,
  ): Promise<Page<<%= classNames.entity %>Result<TWith>>> {
<% } else { -%>
  async execute(query?: ListQuery): Promise<Page<<%= classNames.entity %>>> {
<% } -%>
    const resolved = resolveListQuery(query);

<% if (hasTimestamps) { -%>
    // Default sort: `created_at desc, id desc` (id is the stable keyset
    // tie-break). A caller `sort_by` that names a real column is honored in the
    // requested direction with the id tie-break appended; an unknown column
    // falls back to the default.
<% } else { -%>
    // Default sort: `id desc`. This entity has no `timestamps` behavior, so
    // there is no `created_at` column to sort by — and none is needed: the uuid
    // primary key is already a total order, which is the property the tie-break
    // exists for. `resolveListQuery` still defaults `sort_by` to `created_at`,
    // which simply does not resolve to a column here and falls through to this
    // branch. A caller `sort_by` that names a real column is honored in the
    // requested direction with the id tie-break appended.
<% } -%>
    //
    // Expressed as COLUMN KEYS, not a rendered SQL fragment: the repository
    // renders it against whichever table handle the executing path holds, and the
    // relational query builder (the `with`-include path) aliases the root table
    // (REL-2 §2.4). A pre-rendered fragment would name `<%= entityNamePlural %>`,
    // which is not in scope there.
    const sortColumn = resolved.sortBy.replace(
      /_([a-z])/g,
      (_m: string, c: string) => c.toUpperCase(),
    );
    const known =
      (<%= entityNamePlural %> as unknown as Record<string, unknown>)[sortColumn] !== undefined;
    const sort: SortTerm[] = known
      ? [
          { column: sortColumn, direction: resolved.sortOrder },
          { column: 'id', direction: 'desc' },
        ]
<% if (hasTimestamps) { -%>
      : [
          { column: 'createdAt', direction: 'desc' },
          { column: 'id', direction: 'desc' },
        ];
<% } else { -%>
      : [{ column: 'id', direction: 'desc' }];
<% } -%>

    // Arbitrary where-filters are NOT modeled in v1 (the ListQuery owns only
    // pagination + sort); `where` stays undefined so the list is unfiltered by
    // default. A future filter seam ANDs predicates here and passes the same
    // `where` to both `list` and `count` so `total`/`pageCount` stay accurate.
    const where: SQL | undefined = undefined;

<% if (hasTimestamps) { -%>
    // KEYSET SEAM (deferred — v1 fetches by offset). When the keyset upgrade
    // lands, branch here on `resolved.cursor`: decode it and fetch by
    // `WHERE (created_at, id) < (cursorCreatedAt, cursorId)` LIMIT pageSize,
    // dropping the offset. The envelope + nextCursor below are unchanged.
<% } else { -%>
    // No KEYSET SEAM here: the cursor codec encodes `(created_at, id)` and this
    // entity has no `created_at`, so `computeNextCursor` yields null and there
    // is nothing to seek from. Offset paging is the whole story until the YAML
    // adds the `timestamps` behavior.
<% } -%>
    const [items, total] = await Promise.all([
<% if (includes) { -%>
      this.service.list<TWith>({
        where,
        limit: resolved.pageSize,
        offset: resolved.offset,
        sort,
        ...(include === undefined ? {} : { with: include }),
      }),
<% } else { -%>
      this.service.list({
        where,
        limit: resolved.pageSize,
        offset: resolved.offset,
        sort,
      }),
<% } -%>
      this.service.count(where),
    ]);

    return buildPage(items, total, resolved);
  }
}
