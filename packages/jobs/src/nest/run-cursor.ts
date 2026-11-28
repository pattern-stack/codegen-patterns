import type { Run, RunStatus } from '../index.ts';
import { opsCursorOf, positionOfOpsCursor, timeKeyOf, timeKeySchema } from './ops-cursor.ts';

/**
 * Keyset cursors over a job's runs, newest first: the operator cursor's codec (`ops-cursor.ts`) over the last run's
 * `(createdAt, id)` and the list's filters. Passed back with other filters a cursor is `JobCursorStaleError` (409,
 * `stale_cursor`); a cursor no read returned is a 400 naming `next_cursor`, the public page's field.
 */

export interface RunListFilters {
  jobKey: string;
  status: RunStatus | undefined;
}

const filtersOf = (filters: RunListFilters) => ({ jobKey: filters.jobKey, status: filters.status ?? null });

/** The cursor after `run`, the last of a page. */
export function runCursorOf(run: Run, filters: RunListFilters): string {
  return opsCursorOf(timeKeyOf(run.createdAt, run.id), filtersOf(filters));
}

/** Where a page continues: after the cursor's run, once its filters match these. */
export function beforeOfCursor(
  cursor: string | undefined,
  filters: RunListFilters,
): { createdAt: Date; id: string } | undefined {
  const at = positionOfOpsCursor(cursor, timeKeySchema, filtersOf(filters), 'next_cursor');
  return at && { createdAt: at.at, id: at.id };
}
