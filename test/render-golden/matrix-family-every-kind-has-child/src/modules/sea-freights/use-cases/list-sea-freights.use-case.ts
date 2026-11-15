
import { BadRequestException, Injectable } from '@nestjs/common';
import { buildPage, resolveListQuery, type ListQuery, type Page } from '@shared/http/page';
import { hasColumn, type RowFilter, type SortTerm } from '@shared/base-classes/base-repository';
import { SeaFreightService } from '../sea-freight.service';
import { shipments } from '../../shipments/shipment.entity';
import { sea_freights } from '../sea-freight.entity';
import { flattenBase } from '@shared/base-classes/inheritance';
import type {
  SeaFreightFlat,
  SeaFreightInclude,
  SeaFreightNoInclude,
} from '../sea-freight.repository';

/**
 * Paginated list use-case for sea_freights (pagination-by-default).
 *
 * Composes the flat list read (`service.listFlat`, or `service.list` + `flattenBase` when it is child-rooted) + its
 * count into a `Page<SeaFreightFlat>` envelope. Defaults: page 1,
 * pageSize 50 (max 200), sort `id desc` — shipments declares no
 * `timestamps` behavior, so there is no `created_at` to sort by; the uuid
 * primary key is already a total order, which is what the tie-break is for.
 * `total`/`pageCount`
 * reflect the (optionally filtered) set, so pagination composes with where
 * filters orthogonally — it works fully unfiltered too. `options.where` is the
 * filter seam — a ROW FILTER, `(t) => eq(t.name, x)`, handed whichever table
 * handle the executing path holds (READ-1 §4); the same value reaches `list` and
 * `count`, so the page and its total describe one set: the entity's search use case, when its YAML declares one, ANDs
 * its predicates and pages through here, so search and list share one
 * envelope (#744).
 *
 * v1 ENGINE = OFFSET, and `nextCursor` is always null here: the cursor encodes
 * `(created_at, id)`, which this entity has no `created_at` for. Add the
 * `timestamps` behavior to the YAML if you want cursor paging.
 */
@Injectable()
export class ListSeaFreightsUseCase {
  constructor(private readonly service: SeaFreightService) {}

  /**
   * RFC-0006 §3.2, §3.3, §5: a sea_freight list is FLAT. `include` is the typed include tree the controller
   * resolved against the allowlist (REL-2 §5); the base relation is never one (it is in the body).
   *
   * Two roots, both ONE statement (charter I4):
   *  - BASE-rooted (default): `service.listFlat` is the base's `listKind('sea')`, so the default
   *    sort and a sort on a base column work. The include rides the same statement.
   *  - CHILD-rooted: a sort on a column of this table, or any `where` (a row filter on `sea_freights`; a
   *    search names only this table's columns, R7). It reads `service.list` with the base joined in and hoists the
   *    base's columns (`flattenBase`). A base column cannot order this root (RFC-0006 §8), so a `sort_by` that names
   *    one together with a `where` is a 400 (`sort_not_combinable`); with no `sort_by` the order is `id desc`.
   *
   * The roots treat a base row with no child row differently, on purpose: the base-rooted read throws
   * `OrphanBaseError` (a whole page fails loudly, as the corruption it is), while the child-rooted read starts at
   * this table and never sees the row.
   */
  async execute<TWith extends SeaFreightInclude = SeaFreightNoInclude>(
    listQuery?: ListQuery,
    listOptions: { include?: TWith; where?: RowFilter<typeof sea_freights> } = {},
  ): Promise<Page<SeaFreightFlat<TWith>>> {
    const { include: includeTree, where: whereClause } = listOptions;
    const resolvedQuery = resolveListQuery(listQuery);

    // Default sort: `id desc`. This entity has no `timestamps` behavior, so
    // there is no `created_at` column to sort by — and none is needed: the uuid
    // primary key is already a total order, which is the property the tie-break
    // exists for. `resolveListQuery` still defaults `sort_by` to `created_at`,
    // which simply does not resolve to a column here and falls through to this
    // branch. A caller `sort_by` that names a real column is honored in the
    // requested direction with the id tie-break appended.
    //
    // Expressed as COLUMN KEYS, not a rendered SQL fragment: the repository
    // renders it against whichever table handle the executing path holds, and the
    // relational query builder (the `with`-include path) aliases the root table
    // (REL-2 §2.4). A pre-rendered fragment would name `shipments`,
    // which is not in scope there.
    const sortColumn = resolvedQuery.sortBy.replace(
      /_([a-z])/g,
      (_m: string, c: string) => c.toUpperCase(),
    );
    // `hasColumn` — the repository's own column test (an own-key check, so `?sort_by=to_string` is unknown).
    // A column BOTH tables carry (`id`, `kind`, the tenant column) orders this table's own read when a filter makes
    // the read child-rooted, and the base's otherwise — it is only a base column to refuse when this table lacks it.
    const inBase = hasColumn(shipments, sortColumn);
    const inChild = hasColumn(sea_freights, sortColumn);
    const isChildColumn = inChild && (whereClause !== undefined || !inBase);
    const isBaseColumn = inBase && !isChildColumn;
    const childRooted = whereClause !== undefined || isChildColumn;
    // RFC-0006 §8: no single read filters on this table's columns and sorts on the base's. A caller who NAMES a base
    // column with a filter is refused, not answered in another order. (A request that names no `sort_by` is not
    // refused: it gets the child-rooted default, `id desc`.)
    if (whereClause !== undefined && isBaseColumn && listQuery?.sort_by !== undefined) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'sort_not_combinable',
        message: `sort_by '${resolvedQuery.sortBy}' is a column of shipment and cannot be combined with this filter in v1: sort on a sea_freight column, or drop the filter.`,
      });
    }
    const sortTerms: SortTerm[] = childRooted
      ? isChildColumn
        ? [
            { column: sortColumn, direction: resolvedQuery.sortOrder },
            { column: 'id', direction: 'desc' },
          ]
        : [{ column: 'id', direction: 'desc' }]
      : isBaseColumn
        ? [
            { column: sortColumn, direction: resolvedQuery.sortOrder },
            { column: 'id', direction: 'desc' },
          ]
        : [{ column: 'id', direction: 'desc' }];

    // The ListQuery owns only pagination + sort; filtering is the caller's
    // `where` (undefined = unfiltered). The same `where` goes to both `list`
    // and `count`, so `total`/`pageCount` describe the filtered set.

    // No KEYSET SEAM here: the cursor codec encodes `(created_at, id)` and this
    // entity has no `created_at`, so `computeNextCursor` yields null and there
    // is nothing to seek from. Offset paging is the whole story until the YAML
    // adds the `timestamps` behavior.
    if (childRooted) {
      const [childRows, childTotal] = await Promise.all([
        this.service.list({
          where: whereClause,
          limit: resolvedQuery.pageSize,
          offset: resolvedQuery.offset,
          sort: sortTerms,
          // The one cast: the typed `with` of a child read cannot name the base relation (it is not an include).
          with: { ...includeTree, shipment: true as const } as never,
        }),
        this.service.count(whereClause),
      ]);
      const flatChildRows = (childRows as unknown as globalThis.Array<globalThis.Record<string, unknown>>).map(
        (row) => flattenBase(row as never, 'shipment'),
      ) as unknown as Array<SeaFreightFlat<TWith>>;
      return buildPage(flatChildRows, childTotal, resolvedQuery);
    }
    const [pageRows, rowTotal] = await Promise.all([
      this.service.listFlat<TWith>(
        { limit: resolvedQuery.pageSize, offset: resolvedQuery.offset, sort: sortTerms },
        includeTree === undefined ? undefined : { with: includeTree },
      ),
      this.service.countFlat(),
    ]);

    return buildPage(pageRows, rowTotal, resolvedQuery);
  }
}
