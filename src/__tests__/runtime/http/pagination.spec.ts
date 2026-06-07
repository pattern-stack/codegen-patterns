/**
 * Runtime pagination contract tests (pagination-by-default).
 *
 * Locks the `Page<T>` envelope math, the ListQuery resolution (clamp +
 * defaults), and the opaque cursor codec round-trip — the contract every
 * generated list endpoint depends on.
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPage,
  clampPage,
  clampPageSize,
  computeNextCursor,
  decodeCursor,
  encodeCursor,
  ListQuerySchema,
  resolveListQuery,
} from '../../../../runtime/http/pagination';

describe('pagination — clampPageSize', () => {
  it('defaults to 50 for undefined / non-finite', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  });
  it('floors at 1 and caps at MAX_PAGE_SIZE', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
    expect(clampPageSize(10_000)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(75)).toBe(75);
  });
});

describe('pagination — clampPage', () => {
  it('defaults to 1 and floors below 1', () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-3)).toBe(1);
    expect(clampPage(4)).toBe(4);
  });
});

describe('pagination — resolveListQuery', () => {
  it('applies defaults: page 1, pageSize 50, sort created_at desc, offset 0', () => {
    const r = resolveListQuery(undefined);
    expect(r).toMatchObject({
      page: 1,
      pageSize: 50,
      offset: 0,
      sortBy: 'created_at',
      sortOrder: 'desc',
    });
  });
  it('computes offset from clamped page/pageSize', () => {
    const r = resolveListQuery({ page: 3, pageSize: 20 });
    expect(r.offset).toBe(40);
  });
  it('honors sort_by / sort_order and carries cursor through', () => {
    const r = resolveListQuery({ sort_by: 'name', sort_order: 'asc', cursor: 'abc' });
    expect(r.sortBy).toBe('name');
    expect(r.sortOrder).toBe('asc');
    expect(r.cursor).toBe('abc');
  });
  it('coerces string querystring numbers (page/pageSize)', () => {
    const parsed = ListQuerySchema.parse({ page: '2', pageSize: '25' });
    const r = resolveListQuery(parsed);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(25);
  });
  it('accepts a cursor without error even though v1 ignores it for fetching', () => {
    expect(() => ListQuerySchema.parse({ cursor: 'opaque' })).not.toThrow();
  });
  it('passes through arbitrary where-filters', () => {
    const parsed = ListQuerySchema.parse({ authorId: 'x', page: '1' });
    expect((parsed as Record<string, unknown>).authorId).toBe('x');
  });
});

describe('pagination — cursor codec', () => {
  it('round-trips (createdAt, id)', () => {
    const createdAt = new Date('2026-06-07T12:00:00.000Z');
    const id = '11111111-1111-1111-1111-111111111111';
    const decoded = decodeCursor(encodeCursor({ createdAt, id }));
    expect(decoded?.id).toBe(id);
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString());
  });
  it('returns null for malformed input rather than throwing', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    expect(decodeCursor(Buffer.from('"oops"', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('["bad-date","id"]', 'utf8').toString('base64url'))).toBeNull();
  });
});

describe('pagination — computeNextCursor', () => {
  const rows = [{ createdAt: new Date('2026-01-02T00:00:00Z'), id: 'a' }];
  it('is null when no more rows remain', () => {
    expect(computeNextCursor(rows, false)).toBeNull();
  });
  it('is null for an empty page', () => {
    expect(computeNextCursor([], true)).toBeNull();
  });
  it('encodes the last row when more rows remain', () => {
    const cursor = computeNextCursor(rows, true);
    expect(cursor).not.toBeNull();
    expect(decodeCursor(cursor as string)?.id).toBe('a');
  });
  it('is null when the last row lacks createdAt/id', () => {
    expect(computeNextCursor([{ foo: 1 }], true)).toBeNull();
  });
});

describe('pagination — buildPage envelope math', () => {
  const mkRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      createdAt: new Date(2026, 0, i + 1),
      id: String(i),
    }));

  it('first of several pages: nextCursor non-null, pageCount = ceil(total/pageSize)', () => {
    const items = mkRows(50);
    const page = buildPage(items, 120, { page: 1, pageSize: 50, offset: 0 });
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(50);
    expect(page.total).toBe(120);
    expect(page.pageCount).toBe(3);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items).toHaveLength(50);
  });

  it('last page: nextCursor is null', () => {
    const items = mkRows(20);
    const page = buildPage(items, 120, { page: 3, pageSize: 50, offset: 100 });
    expect(page.pageCount).toBe(3);
    expect(page.nextCursor).toBeNull();
  });

  it('empty result: pageCount 1, total 0, nextCursor null', () => {
    const page = buildPage([], 0, { page: 1, pageSize: 50, offset: 0 });
    expect(page.pageCount).toBe(1);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([]);
  });

  it('out-of-range page: empty items but correct total/pageCount', () => {
    const page = buildPage([], 120, { page: 99, pageSize: 50, offset: 4900 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(120);
    expect(page.pageCount).toBe(3);
    expect(page.nextCursor).toBeNull();
  });
});
