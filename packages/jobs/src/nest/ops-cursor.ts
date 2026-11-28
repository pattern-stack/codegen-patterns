import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { fingerprintOf } from './fingerprint.ts';
import { JobCursorStaleError } from './jobs.errors.ts';

/**
 * The operator surface's keyset cursors: opaque base64url JSON of the last row's position (`p`) and a fingerprint of
 * the filters that produced it (`f`). Passed back with other filters a cursor is `JobCursorStaleError` (409, `stale_cursor`); a cursor no
 * read returned is a 400. The one codec: the public run list's `run-cursor.ts` is this over a (time, id) position.
 */

type Filters = Record<string, string | number | boolean | null | undefined>;

const filtersFingerprint = (filters: Filters) =>
  fingerprintOf(
    Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v ?? null])),
  );

/** The 400 for a cursor no read returned, naming the page's own field (`nextCursor`, or the public `next_cursor`). */
const malformed = (pageField: string) =>
  new BadRequestException({
    message: `cursor is not one this read returned; pass the ${pageField} of the previous page`,
    code: 'invalid_cursor',
  });

export function opsCursorOf<P>(position: P, filters: Filters): string {
  return Buffer.from(
    JSON.stringify({ p: position, f: filtersFingerprint(filters) }),
  ).toString('base64url');
}

/** Where a page continues: the cursor's position, once its filters match these. */
export function positionOfOpsCursor<P>(
  cursor: string | undefined,
  schema: z.ZodType<P>,
  filters: Filters,
  pageField = 'nextCursor',
): P | undefined {
  if (cursor === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw malformed(pageField);
  }
  const parsed = z.object({ p: schema, f: z.string() }).safeParse(decoded);
  if (!parsed.success) throw malformed(pageField);
  if (parsed.data.f !== filtersFingerprint(filters))
    throw new JobCursorStaleError();
  return parsed.data.p;
}

/** A (time, id) position: an ISO time to the millisecond and a uuid. */
export const timeKeySchema = z
  .object({ t: z.iso.datetime({ precision: 3 }), i: z.guid() })
  .transform(({ t, i }) => ({ at: new Date(t), id: i }));

export const timeKeyOf = (at: Date, id: string) => ({
  t: at.toISOString(),
  i: id,
});

/** An item position: failed first (rank 0), then the rest (rank 1), by ordinal. */
export const itemKeySchema = z.object({
  rank: z.union([z.literal(0), z.literal(1)]),
  ordinal: z.number().int().nonnegative(),
});
