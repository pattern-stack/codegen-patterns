---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.listUseCase : null %>"
force: true
---
<%_ if (typeof clpOutputPaths !== 'undefined') { -%>
<%- generatedBanner %>
import { Injectable } from '@nestjs/common';
import { asc, desc, sql, type SQL } from 'drizzle-orm';
import { buildPage, resolveListQuery, type ListQuery, type Page } from '<%= paginationImport %>';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from '../<%= entityName %>.entity';

/**
 * Paginated list use-case for <%= entityNamePlural %> (pagination-by-default).
 *
 * Composes `service.list({ where, limit, offset, orderBy })` + `service.count(where)`
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

  async execute(query?: ListQuery): Promise<Page<<%= classNames.entity %>>> {
    const resolved = resolveListQuery(query);

<% if (hasTimestamps) { -%>
    // Default sort: `created_at desc, id desc` (id is the stable keyset
    // tie-break). A caller `sort_by` that names a real column is honored in the
    // requested direction with the id tie-break appended; an unknown column
    // falls back to the default. Composed as a single SQL fragment because the
    // base repository's `orderBy` takes one expression.
<% } else { -%>
    // Default sort: `id desc`. This entity has no `timestamps` behavior, so
    // there is no `created_at` column to sort by — and none is needed: the uuid
    // primary key is already a total order, which is the property the tie-break
    // exists for. `resolveListQuery` still defaults `sort_by` to `created_at`,
    // which simply does not resolve to a column here and falls through to this
    // branch. A caller `sort_by` that names a real column is honored in the
    // requested direction with the id tie-break appended. Composed as a single
    // SQL fragment because the base repository's `orderBy` takes one expression.
<% } -%>
    const dir = resolved.sortOrder === 'asc' ? asc : desc;
    const col = (<%= entityNamePlural %> as unknown as Record<string, unknown>)[
      resolved.sortBy.replace(/_([a-z])/g, (_m: string, c: string) => c.toUpperCase())
    ];
    const orderBy: SQL =
      col === undefined
<% if (hasTimestamps) { -%>
        ? sql`${desc(<%= entityNamePlural %>.createdAt)}, ${desc(<%= entityNamePlural %>.id)}`
<% } else { -%>
        ? sql`${desc(<%= entityNamePlural %>.id)}`
<% } -%>
        : sql`${dir(col as never)}, ${desc(<%= entityNamePlural %>.id)}`;

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
      this.service.list({
        where,
        limit: resolved.pageSize,
        offset: resolved.offset,
        orderBy,
      }),
      this.service.count(where),
    ]);

    return buildPage(items, total, resolved);
  }
}
<%_ } -%>
