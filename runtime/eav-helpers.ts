/**
 * EAV helpers
 *
 * Small, pure utilities used by services that dual-write to the EAV value
 * table alongside their own table.
 *
 * - `toEavRows` builds value-table insert rows from a flat `{ key: value }`
 *   bag, resolving the `fieldDefinitionId` via a caller-supplied map.
 *   Callers own the field-definitions lookup / cache.
 * - `mergeEavRows` inverts: given value-table rows + a definition `id -> key`
 *   map, collapses them into a flat `{ key: value }` bag.
 *
 * Both are sync + allocation-light. They do not touch the DB.
 */

/**
 * Map of field key -> field_definitions.id, scoped to a single entityType.
 */
export type FieldDefinitionIdMap = ReadonlyMap<string, string>;

/**
 * Minimal shape of a value-table row accepted by toEavRows output. Consumers
 * pass their entity's `Insert` type; these are the columns the helper sets.
 */
export interface EavInsertShape {
  entityId: string;
  entityType: string;
  userId: string;
  fieldDefinitionId: string;
  value: unknown;
}

/**
 * Build value-table insert rows from a flat field bag. Keys present in
 * `fields` but missing from `fieldDefIds` are skipped — caller is expected
 * to ensure the definitions exist (first-cut; auto-create is a later step).
 */
export function toEavRows(
  entityId: string,
  entityType: string,
  userId: string,
  fields: Record<string, unknown>,
  fieldDefIds: FieldDefinitionIdMap,
): EavInsertShape[] {
  const rows: EavInsertShape[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const fieldDefinitionId = fieldDefIds.get(key);
    if (!fieldDefinitionId) continue;
    rows.push({ entityId, entityType, userId, fieldDefinitionId, value });
  }
  return rows;
}

/**
 * Collapse EAV rows back into a flat `{ key: value }` bag.
 *
 * Accepts bare value-table rows plus a separate `id -> { key }` map. Later
 * rows win if the same key appears more than once. Call with temporal
 * filtering already applied (e.g. validTo IS NULL) — this function does not
 * interpret validFrom / validTo.
 */
export function mergeEavRows(
  rows: Array<{ fieldDefinitionId: string | null; value: unknown }>,
  defsById: ReadonlyMap<string, { key: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.fieldDefinitionId) continue;
    const def = defsById.get(row.fieldDefinitionId);
    if (!def) continue;
    out[def.key] = row.value;
  }
  return out;
}
