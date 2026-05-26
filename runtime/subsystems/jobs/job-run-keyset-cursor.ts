/**
 * Keyset (seek) cursor codec for `IJobRunService.listJobRuns` (OBS-LIST-1).
 *
 * The list is ordered `created_at DESC, id DESC`. The cursor encodes the
 * `(createdAt, id)` of the last row on the previous page so the next page
 * can seek with `WHERE (created_at, id) < (cursorCreatedAt, cursorId)`
 * rather than an `OFFSET`. Keyset pagination stays O(log n) on deep pages
 * and is stable as new rows arrive at the head.
 *
 * The cursor is opaque to consumers: a base64url-encoded JSON tuple. Shape
 * is an implementation detail — never parse it outside this module.
 *
 * Also hosts `toJobRunSummary`, the single `JobRunRow → JobRunSummary`
 * projection shared by both backends so the narrow shape stays in sync.
 */
import type { JobRunRow } from './job-orchestration.schema';
import type { JobRunSummary } from './job-run-service.protocol';

export interface JobRunKeyset {
  /** `created_at` of the last row on the previous page. */
  createdAt: Date;
  /** `id` (UUID) tie-break of the last row on the previous page. */
  id: string;
}

/** Default page size when `limit` is omitted. */
export const DEFAULT_LIST_LIMIT = 50;
/** Hard upper bound on page size to keep a single read bounded. */
export const MAX_LIST_LIMIT = 200;

/** Clamp a caller-supplied `limit` into `[1, MAX_LIST_LIMIT]`. */
export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return floored;
}

export function encodeKeysetCursor(keyset: JobRunKeyset): string {
  const tuple = [keyset.createdAt.toISOString(), keyset.id];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into its `(createdAt, id)` keyset. Returns
 * `null` for a malformed cursor so callers can treat garbage input as
 * "start from the beginning" rather than throwing on user-supplied data.
 */
export function decodeKeysetCursor(cursor: string): JobRunKeyset | null {
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
 * Project a raw `job_run` row into the narrow `JobRunSummary` shape exposed
 * by `listJobRuns`. `errorMessage` is pulled from the jsonb `error.message`.
 */
export function toJobRunSummary(r: JobRunRow): JobRunSummary {
  return {
    runId: r.id,
    rootRunId: r.rootRunId,
    parentRunId: r.parentRunId,
    triggerSource: r.triggerSource,
    triggerRef: r.triggerRef,
    jobType: r.jobType,
    pool: r.pool,
    status: r.status,
    scopeEntityType: r.scopeEntityType,
    scopeEntityId: r.scopeEntityId,
    tenantId: r.tenantId,
    attempts: r.attempts,
    errorMessage: r.error?.message ?? null,
    runAt: r.runAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
  };
}
