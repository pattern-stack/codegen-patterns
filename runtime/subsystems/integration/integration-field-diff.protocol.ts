/**
 * Integration subsystem — field-diff protocol (port)
 *
 * `IFieldDiffer<T>` is the pluggable differ seam. The default implementation
 * (`DeepEqualDiffer`, ships in SYNC-5) walks every field except an ignore
 * list; CDC-aware differs can skip comparison for fields the provider didn't
 * flag as changed.
 *
 * `FieldDiffSchema` is the structural enforcement of the `changed_fields`
 * column per ADR-0003 — enforced at write time by the recorder service so
 * consumers can rely on the shape in downstream queries.
 */
import { z } from 'zod';

// ============================================================================
// FieldDiff shape — the ADR-0003 contract
// ============================================================================

/**
 * Structured per-field change. Enforced shape for `integration_run_items.changed_fields`.
 *
 * `created` items set `from: null, to: <value>` for every non-null field.
 * `deleted` items set `from: <value>, to: null`.
 * `noop` items carry `{}`.
 */
export const FieldDiffValueSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});

export const FieldDiffSchema = z.record(z.string(), FieldDiffValueSchema);

export type FieldDiffValue = z.infer<typeof FieldDiffValueSchema>;
export type FieldDiff = z.infer<typeof FieldDiffSchema>;

/** Result of comparing a new record against its existing local state. */
export type DiffResult = FieldDiff | 'noop';

// ============================================================================
// IFieldDiffer
// ============================================================================

/**
 * Pluggable differ. Default ships in SYNC-5 as `DeepEqualDiffer<T>` —
 * deep-equal over every field except an ignore list (`updated_at` and other
 * row metadata). CDC-aware differs restrict comparison to
 * `providerChangedFields` when supplied.
 */
export interface IFieldDiffer<T> {
  /**
   * @param existing — current local state, or `null` when the record is new
   * @param incoming — the canonical record coming from the adapter
   * @param providerChangedFields — optional hint from CDC-capable sources;
   *   when present, differ may restrict the comparison to these fields
   */
  diff(
    existing: T | null,
    incoming: T,
    providerChangedFields?: string[],
  ): DiffResult;
}
