/**
 * Transcript surface capability descriptor (ADR-036 §6).
 *
 * The transcript surface is an **incremental-read surface**: it has no L2
 * sub-ports (no field/picklist/association readers — that's CRM-shaped), so the
 * descriptor carries only `entities` — the consumer-defined entity names this
 * adapter can resolve via the L1 change-source registry. Runtime coverage data,
 * not a type bound on `TranscriptPort` (the port stays entity-agnostic; ADR-036
 * §6).
 */
export interface TranscriptCapabilities {
  /**
   * Consumer-defined entity names this adapter can resolve (runtime coverage,
   * not a type bound). e.g. `['transcript']`.
   */
  entities: readonly string[];
  // Future L2 transcript ports get a boolean flag here as they ship.
}

/**
 * The empty capability set — no entities. Spread on top to declare coverage:
 *
 * ```ts
 * const GOOGLE_TRANSCRIPT_CAPABILITIES: TranscriptCapabilities = {
 *   ...NO_TRANSCRIPT_CAPABILITIES,
 *   entities: ['transcript'],
 * };
 * ```
 */
export const NO_TRANSCRIPT_CAPABILITIES: TranscriptCapabilities = {
  entities: [],
};
