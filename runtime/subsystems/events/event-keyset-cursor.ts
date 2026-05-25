/**
 * Keyset (seek) cursor codec for `IEventReadPort.listEvents` (OBS-LIST-1).
 *
 * The list is ordered `occurred_at DESC, id DESC`. The cursor encodes the
 * `(occurredAt, id)` of the last row on the previous page so the next page
 * seeks with `WHERE (occurred_at, id) < (cursorOccurredAt, cursorId)`.
 *
 * The cursor is opaque to consumers: a base64url-encoded JSON tuple. Shape
 * is an implementation detail — never parse it outside this module.
 *
 * Mirrors the jobs keyset codec; kept separate because the events subsystem
 * must not depend on `runtime/subsystems/jobs/`.
 */

export interface EventKeyset {
  occurredAt: Date;
  id: string;
}

/** Default page size when `limit` is omitted. */
export const DEFAULT_EVENT_LIST_LIMIT = 50;
/** Hard upper bound on page size. */
export const MAX_EVENT_LIST_LIMIT = 200;

/** Clamp a caller-supplied `limit` into `[1, MAX_EVENT_LIST_LIMIT]`. */
export function clampEventLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_EVENT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_EVENT_LIST_LIMIT) return MAX_EVENT_LIST_LIMIT;
  return floored;
}

export function encodeEventCursor(keyset: EventKeyset): string {
  const tuple = [keyset.occurredAt.toISOString(), keyset.id];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into its `(occurredAt, id)` keyset. Returns
 * `null` for malformed input so user-supplied garbage is treated as "start
 * from the beginning" rather than throwing.
 */
export function decodeEventCursor(cursor: string): EventKeyset | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed;
    if (typeof iso !== 'string' || typeof id !== 'string') return null;
    const occurredAt = new Date(iso);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}
