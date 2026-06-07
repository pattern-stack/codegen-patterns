/**
 * Pagination envelope + ListQuery contract for generated entity list endpoints
 * (pagination-by-default).
 *
 * Every generated `GET /<entities>` returns a {@link Page} envelope instead of
 * a bare `T[]`. The request shape is {@link ListQuery} (page/cursor/pageSize +
 * default sort) merged with arbitrary where-filters at the controller.
 *
 * Mirrors the in-repo precedent: the jobs subsystem's `JobRunPage`
 * (`{ items, nextCursor }`) and its opaque keyset cursor codec
 * (`runtime/subsystems/jobs/job-run-keyset-cursor.ts`). The entity envelope
 * EXTENDS that minimal shape with `page/pageCount/total/pageSize` so a numbered
 * UI (jump-to-page) works while `nextCursor` stays contract-stable for the
 * later keyset upgrade.
 *
 * ENGINE NOTE (v1): the list use-case fetches by OFFSET (page-based). The
 * `nextCursor` is computed from the last row and emitted from day one so the
 * contract never changes, but cursor-REQUEST honoring (keyset seek) is a
 * DEFERRED seam — see the TODO in the generated list use-case / the repository
 * query branch. `ListQuery.cursor` is ACCEPTED (no validation error) even
 * though v1 ignores it for fetching.
 */

import { z } from 'zod';

// ============================================================================
// Defaults + clamp
// ============================================================================

/** Default page size when `pageSize` is omitted. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard upper bound on page size to keep a single read bounded. */
export const MAX_PAGE_SIZE = 200;
/** Default page (1-based) when `page` is omitted. */
export const DEFAULT_PAGE = 1;
/** Default sort column. */
export const DEFAULT_SORT_BY = 'created_at';
/** Default sort direction. */
export const DEFAULT_SORT_ORDER = 'desc' as const;

/** Clamp a caller-supplied `pageSize` into `[1, MAX_PAGE_SIZE]`. */
export function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }
  const floored = Math.floor(pageSize);
  if (floored < 1) return 1;
  if (floored > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return floored;
}

/** Clamp a caller-supplied `page` to a 1-based integer (floor 1). */
export function clampPage(page: number | undefined): number {
  if (typeof page !== 'number' || !Number.isFinite(page)) {
    return DEFAULT_PAGE;
  }
  const floored = Math.floor(page);
  return floored < 1 ? 1 : floored;
}

// ============================================================================
// ListQuery schema (request)
// ============================================================================

/**
 * Zod schema for the universal list query string. All keys optional —
 * pagination works fully UNFILTERED (the default mode). `pageSize` is clamped
 * (default 50, max 200) and `sort_order` defaults to `desc`. Arbitrary where
 * filters are NOT modeled here (they're parsed/passed through at the controller
 * via `.passthrough()`); this schema owns ONLY the pagination + sort knobs so
 * the defaults + clamp land in one place.
 *
 * `cursor` is accepted but v1 ignores it for fetching (offset engine) — the
 * keyset seek is the deferred seam. Passing a `nextCursor` back never errors.
 */
export const ListQuerySchema = z
  .object({
    page: z.coerce.number().int().optional(),
    cursor: z.string().optional(),
    pageSize: z.coerce.number().int().optional(),
    sort_by: z.string().optional(),
    sort_order: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough();

/** Parsed list query (pre-clamp). Use {@link resolveListQuery} to normalize. */
export type ListQuery = z.infer<typeof ListQuerySchema>;

/**
 * Normalized pagination options resolved from a raw {@link ListQuery}: clamped
 * `page`/`pageSize`, computed `offset`, and a defaulted sort. The generated
 * list use-case feeds these straight into `service.list({ limit, offset, ... })`.
 */
export interface ResolvedListQuery {
  page: number;
  pageSize: number;
  /** `(page - 1) * pageSize`. */
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  /** Opaque cursor as passed by the caller (v1: not honored — deferred seam). */
  cursor?: string;
}

/**
 * Resolve a raw list query into normalized, clamped pagination options.
 * Defaults: page 1, pageSize 50 (max 200), sort `created_at desc`.
 */
export function resolveListQuery(query: ListQuery | undefined): ResolvedListQuery {
  const page = clampPage(query?.page);
  const pageSize = clampPageSize(query?.pageSize);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortBy: query?.sort_by ?? DEFAULT_SORT_BY,
    sortOrder: query?.sort_order ?? DEFAULT_SORT_ORDER,
    cursor: query?.cursor,
  };
}

// ============================================================================
// Page envelope (response)
// ============================================================================

/**
 * One page of a paginated list response. EXTENDS the jobs subsystem's minimal
 * `{ items, nextCursor }` shape with the numbered-UI fields:
 *
 *   - `page`       — 1-based page number of THIS page.
 *   - `pageCount`  — total number of pages (`ceil(total / pageSize)`, min 1).
 *   - `total`      — total matching rows (reflects any where-filter).
 *   - `pageSize`   — the (clamped) page size used.
 *   - `nextCursor` — opaque keyset cursor of the LAST row, or `null` on the
 *                    last page / empty result. Contract-stable from day one;
 *                    v1 emits it but fetches by offset.
 */
export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  nextCursor: string | null;
}

// ============================================================================
// Opaque cursor codec (encodes (createdAt, id))
// ============================================================================

/** Keyset tuple a {@link Page.nextCursor} encodes. */
export interface PageKeyset {
  /** `created_at` of the last row on this page. */
  createdAt: Date;
  /** `id` (UUID) tie-break of the last row on this page. */
  id: string;
}

/**
 * Encode a `(createdAt, id)` keyset into an opaque, base64url cursor. The shape
 * (a JSON tuple) is an implementation detail — never parse it outside this
 * module. Mirrors `encodeKeysetCursor` in the jobs subsystem.
 */
export function encodeCursor(keyset: PageKeyset): string {
  const tuple = [keyset.createdAt.toISOString(), keyset.id];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into its `(createdAt, id)` keyset. Returns
 * `null` for a malformed cursor so a caller can treat garbage as "start from
 * the beginning" rather than throw on user-supplied data.
 */
export function decodeCursor(cursor: string): PageKeyset | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed;
    if (typeof iso !== 'string' || typeof id !== 'string') return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Compute the `nextCursor` for a page of rows: the opaque cursor of the LAST
 * row when more pages remain, else `null`. A row is expected to carry
 * `createdAt: Date` and `id: string` (the default-sort keyset). Rows missing
 * either field yield `null` (cursor not derivable — caller falls back to offset
 * paging, which is the v1 engine anyway).
 *
 * @param rows      the items on this page (already fetched, in sort order)
 * @param hasMore   whether more rows exist beyond this page
 *                  (`offset + rows.length < total`)
 */
export function computeNextCursor(
  rows: ReadonlyArray<unknown>,
  hasMore: boolean,
): string | null {
  if (!hasMore || rows.length === 0) return null;
  const last = rows[rows.length - 1] as { createdAt?: unknown; id?: unknown };
  const createdAt = last?.createdAt;
  const id = last?.id;
  if (!(createdAt instanceof Date) || typeof id !== 'string') return null;
  return encodeCursor({ createdAt, id });
}

/**
 * Assemble a {@link Page} envelope from a fetched page of rows + the total
 * matching count + the resolved query. Computes `pageCount` and `nextCursor`.
 * The single place the envelope shape is constructed, so the generated list
 * use-case stays a thin call.
 */
export function buildPage<T>(
  items: T[],
  total: number,
  resolved: Pick<ResolvedListQuery, 'page' | 'pageSize' | 'offset'>,
): Page<T> {
  const pageCount = total === 0 ? 1 : Math.ceil(total / resolved.pageSize);
  const hasMore = resolved.offset + items.length < total;
  return {
    items,
    page: resolved.page,
    pageCount,
    total,
    pageSize: resolved.pageSize,
    nextCursor: computeNextCursor(items as ReadonlyArray<unknown>, hasMore),
  };
}
