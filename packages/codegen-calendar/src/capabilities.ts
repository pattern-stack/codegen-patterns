/**
 * Calendar surface capability descriptor (ADR-036 §6).
 *
 * The calendar surface is an **incremental-read surface**: it has no L2
 * sub-ports (no field/picklist/association readers — that's CRM-shaped), so the
 * descriptor carries only `entities` — the consumer-defined entity names this
 * adapter can resolve via the L1 change-source registry. This is runtime
 * coverage data, not a type bound on `CalendarPort` (the port stays
 * entity-agnostic; ADR-036 §6).
 */
export interface CalendarCapabilities {
  /**
   * Consumer-defined entity names this adapter can resolve (runtime coverage,
   * not a type bound). e.g. `['meeting']`.
   */
  entities: readonly string[];
  // Future L2 calendar ports get a boolean flag here as they ship.
}

/**
 * The empty capability set — no entities. Spread on top to declare coverage:
 *
 * ```ts
 * const GOOGLE_CALENDAR_CAPABILITIES: CalendarCapabilities = {
 *   ...NO_CALENDAR_CAPABILITIES,
 *   entities: ['meeting'],
 * };
 * ```
 */
export const NO_CALENDAR_CAPABILITIES: CalendarCapabilities = {
  entities: [],
};
