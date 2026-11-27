import { createHash } from 'node:crypto';

/** Fingerprint length: 132 bits of SHA-256, which keeps a cursor under the wire's 64 characters. */
const FINGERPRINT_CHARS = 22;

/**
 * The fingerprint of a value (a read's filters, a run view): the same value gives the same one, whatever order its keys
 * were set in. The app's filter-bound cursors use the same rule; the package keeps its own so it imports nothing from
 * the app (P6).
 */
export function fingerprintOf(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(value, withSortedKeys))
    .digest('base64url')
    .slice(0, FINGERPRINT_CHARS);
}

/** Plain code-unit order, the same on every machine (not `localeCompare`). */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function withSortedKeys(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => byCodeUnit(a, b)),
  );
}
