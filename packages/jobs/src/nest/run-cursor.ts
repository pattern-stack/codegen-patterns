import { BadRequestException } from '@nestjs/common';
import type { Run, RunStatus } from '../index.ts';
import { fingerprintOf } from './fingerprint.ts';
import { JobCursorStaleError } from './jobs.errors.ts';

/**
 * Keyset cursors over a job's runs, newest first: opaque base64url JSON of the last run's `(createdAt, id)` and a
 * fingerprint of the filters that produced it. Passed back with other filters a cursor is `JobCursorStaleError` (409, `stale_cursor`);
 * a cursor no read returned is a 400.
 */

export interface RunListFilters {
  jobKey: string;
  status: RunStatus | undefined;
}

const filtersFingerprint = (filters: RunListFilters) =>
  fingerprintOf({ jobKey: filters.jobKey, status: filters.status ?? null });

/** The cursor after `run`, the last of a page. */
export function runCursorOf(run: Run, filters: RunListFilters): string {
  return Buffer.from(
    JSON.stringify({
      t: run.createdAt.toISOString(),
      i: run.id,
      f: filtersFingerprint(filters),
    }),
  ).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const malformed = () =>
  new BadRequestException({
    message:
      'cursor is not one this read returned; pass the next_cursor of the previous page',
    code: 'invalid_cursor',
  });

/** Where a page continues: after the cursor's run, once its filters match these. */
export function beforeOfCursor(
  cursor: string | undefined,
  filters: RunListFilters,
): { createdAt: Date; id: string } | undefined {
  if (cursor === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw malformed();
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('t' in decoded) ||
    !('i' in decoded) ||
    !('f' in decoded) ||
    typeof decoded.t !== 'string' ||
    typeof decoded.i !== 'string' ||
    typeof decoded.f !== 'string'
  )
    throw malformed();
  const createdAt = new Date(decoded.t);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== decoded.t ||
    !UUID.test(decoded.i)
  )
    throw malformed();
  if (decoded.f !== filtersFingerprint(filters))
    throw new JobCursorStaleError();
  return { createdAt, id: decoded.i };
}
