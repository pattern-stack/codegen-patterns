/**
 * DeepEqualDiffer — default `IFieldDiffer<T>` for the integration subsystem (SYNC-5).
 *
 * Walks every field of `incoming` against `existing`, emitting a structured
 * per-field diff (`{ from, to }`) for every field whose value changed.
 * Returns `'noop'` when the record is unchanged.
 *
 * Design decisions (extracted from the upstream consumer + HS-9 findings):
 *
 * 1. **Ignore list** — row metadata that sinks/services stamp unconditionally
 *    so upstream cannot reasonably disagree:
 *      `id`, `createdAt`, `updatedAt`, `deletedAt`, `type`,
 *      `lastModifiedAt`, `fields`, `providerMetadata`
 *    (`fields` is the EAV bag — it's diffed by the sink's EAV dual-write
 *    path, not at the canonical-record layer.) Consumers augment the list via
 *    `options.ignore` and — when a default is domain data for their entity —
 *    REMOVE a default via `options.unignore` (e.g. an entity whose
 *    `deletedAt` is a vendor-observed retraction tombstone, not row metadata;
 *    see `DeepEqualDifferOptions.unignore`).
 *
 * 2. **`providerChangedFields` hint (CDC)** — when present, restricts the
 *    comparison to the hinted field set. The hint is advisory; fields in
 *    the ignore list are still filtered out even when hinted. Provider
 *    hints are field-NAME-level; they don't override the ignore rules.
 *
 * 3. **Date → ISO string** — `Date` instances are normalized to
 *    `toISOString()` before comparison. Sinks return `Date` from the DB
 *    driver; adapters typically deliver strings. Direct `===` would
 *    always say "changed."
 *
 * 4. **Decimal-string vs number** — Postgres `numeric` columns return as
 *    strings through Drizzle; adapters deliver numbers. When one side is a
 *    number and the other is a numeric string that parses to the same
 *    number, they're equal. The normalizer does NOT coerce non-numeric
 *    strings, and it preserves zero-vs-null distinction.
 *
 * 5. **null-existing path** — `diff(null, incoming)` produces a full
 *    created-shape diff (`{from: null, to: <value>}` for every non-ignored
 *    field). Orchestrator sees this and records `operation: 'created'`.
 */
import { Injectable } from '@nestjs/common';
import type {
  DiffResult,
  FieldDiff,
  IFieldDiffer,
} from './integration-field-diff.protocol';

/**
 * Default ignore list. Keep in integration with consumer canonical-record shapes —
 * adding a row-metadata field here means no integration will ever mark it changed.
 *
 * Includes the columns contributed by the `external_id_tracking` behavior
 * (`external_id`/`externalId`, `provider`, `provider_metadata`/`providerMetadata`).
 * These are integration-tracking metadata, not domain attributes: they ride on the
 * canonical record but must never register as a field change (the external id
 * is the record's identity, not a mutable value). Listed in both snake_case
 * and camelCase so the differ ignores them regardless of the consumer's
 * canonical projection casing.
 */
const DEFAULT_IGNORE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'type',
  'lastModifiedAt',
  'fields',
  'external_id',
  'externalId',
  'provider',
  'provider_metadata',
  'providerMetadata',
]);

export interface DeepEqualDifferOptions {
  /**
   * Extra field names to ignore in addition to the defaults. Consumers can
   * pass `['integration_version']` etc. to augment the base list; values here are
   * merged (not replaced) with `DEFAULT_IGNORE_FIELDS`.
   */
  readonly ignore?: readonly string[];

  /**
   * Field names to REMOVE from the default ignore list — the inverse of
   * `ignore`. Use this to declare that a normally-metadata column is in fact
   * DOMAIN DATA for this entity and must register as a field change.
   *
   * The canonical case (swe-brain ADR-0008 §1, the gap this knob closes):
   * `deletedAt` is in `DEFAULT_IGNORE_FIELDS` because most sinks stamp it as
   * row metadata sinks own unconditionally. But an entity with
   * `softDelete: false` and a domain-owned `deleted_at` carries the
   * vendor-observed retraction tombstone ON the canonical record (a Slack
   * `message_deleted` → `deletedAt`). Without un-ignoring it, the tombstone
   * overlay diffs to `'noop'`, the upsert is skipped, and `deleted_at` never
   * lands. `unignore: ['deletedAt']` makes the differ treat it as domain data.
   *
   * Applied AFTER `ignore` is merged, so `unignore` wins on a field listed in
   * both. Subtracting a field not in the (merged) ignore set is a harmless
   * no-op. Does not touch `DEFAULT_IGNORE_FIELDS` for any other instance.
   */
  readonly unignore?: readonly string[];
}

@Injectable()
export class DeepEqualDiffer<T extends Record<string, unknown>>
  implements IFieldDiffer<T>
{
  private readonly ignore: ReadonlySet<string>;

  constructor(opts: DeepEqualDifferOptions = {}) {
    const merged = new Set<string>(DEFAULT_IGNORE_FIELDS);
    if (opts.ignore) {
      for (const field of opts.ignore) merged.add(field);
    }
    // `unignore` is subtracted last so it wins over a field that also appears
    // in `ignore` or the defaults — "this column is domain data here."
    if (opts.unignore) {
      for (const field of opts.unignore) merged.delete(field);
    }
    this.ignore = merged;
  }

  diff(
    existing: T | null,
    incoming: T,
    providerChangedFields?: string[],
  ): DiffResult {
    // Created-shape: every non-ignored field becomes `{from: null, to}`.
    if (existing === null) {
      const out: FieldDiff = {};
      for (const key of Object.keys(incoming)) {
        if (this.ignore.has(key)) continue;
        const value = (incoming as Record<string, unknown>)[key];
        // Skip fields that are themselves null/undefined — a created record
        // doesn't need to declare "this field is null now" for every
        // untouched column.
        if (value === null || value === undefined) continue;
        out[key] = { from: null, to: value };
      }
      return Object.keys(out).length === 0 ? 'noop' : out;
    }

    // Field set to compare. `providerChangedFields` narrows to a hint set;
    // ignored fields are filtered out regardless of hint.
    const candidates = new Set<string>();
    if (providerChangedFields && providerChangedFields.length > 0) {
      for (const key of providerChangedFields) {
        if (!this.ignore.has(key)) candidates.add(key);
      }
    } else {
      for (const key of Object.keys(incoming)) {
        if (!this.ignore.has(key)) candidates.add(key);
      }
      // Also include keys that exist on existing but not on incoming —
      // e.g. a field that was cleared. This would otherwise be missed when
      // incoming carries an undefined column we drop from the iteration.
      for (const key of Object.keys(existing)) {
        if (this.ignore.has(key)) continue;
        if (!(key in (incoming as Record<string, unknown>))) continue;
        candidates.add(key);
      }
    }

    const out: FieldDiff = {};
    for (const key of candidates) {
      const before = (existing as Record<string, unknown>)[key];
      const after = (incoming as Record<string, unknown>)[key];
      if (!isEqual(before, after)) {
        out[key] = { from: before ?? null, to: after ?? null };
      }
    }

    return Object.keys(out).length === 0 ? 'noop' : out;
  }
}

// ─── equality helpers ───────────────────────────────────────────────────────

/**
 * Field-level equality with the canonical-integration normalizations:
 *   - Date → toISOString (adapters deliver strings)
 *   - numeric-string vs number → numeric equality when both parse
 *   - deep equality for plain objects/arrays (single-level is enough for
 *     canonical records; nested records travel as jsonb columns where the
 *     sink already owns the comparison)
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // After normalization: both may still be non-primitive objects.
  if (
    typeof na === 'object' &&
    typeof nb === 'object' &&
    na !== null &&
    nb !== null
  ) {
    return deepEqualObject(na as Record<string, unknown>, nb as Record<string, unknown>);
  }

  // Numeric string ↔ number: when one side is a number and the other is a
  // string that parses to the same finite number.
  const numericEqual = maybeNumericEqual(na, nb) || maybeNumericEqual(nb, na);
  return numericEqual;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function maybeNumericEqual(a: unknown, b: unknown): boolean {
  // a is string-shape, b is number — parse a and compare. Only when the
  // string looks numeric AND the parse round-trips (no silent NaN pass-
  // through on non-numeric strings).
  if (typeof a !== 'string' || typeof b !== 'number') return false;
  if (a.trim() === '') return false;
  const parsed = Number(a);
  if (!Number.isFinite(parsed)) return false;
  return parsed === b;
}

function deepEqualObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in b)) return false;
    if (!isEqual(a[key], b[key])) return false;
  }
  return true;
}
