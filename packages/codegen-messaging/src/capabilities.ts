/**
 * Messaging surface capability descriptor (ADR-036 §6).
 *
 * The messaging surface is an **incremental-read surface**: it has no L2
 * sub-ports (no field/picklist/association readers — that's CRM-shaped), so the
 * descriptor carries only `entities` plus the messaging-specific `canWrite` flag.
 * Runtime coverage data, not a type bound on `MessagingPort` (the port stays
 * entity-agnostic; ADR-036 §6).
 */
export interface MessagingCapabilities {
  /**
   * Consumer-defined entity names this adapter can resolve (runtime coverage,
   * not a type bound). e.g. `['channel', 'message']`. `conversation` is derived
   * by domain segmentation and never appears here.
   */
  entities: readonly string[];
  /**
   * Whether this adapter can post/edit/react as the app's bot user (ADR-0008 §9).
   * Optional; the write path **ships dark** in v1 — left unset / `false` until the
   * actuator activates (`chat:write` is requested only then; v1 OAuth is
   * read-scopes-only). When `true`, `MessagingPort.write` must be present.
   */
  canWrite?: boolean;
}

/**
 * The empty capability set — no entities, no write. Spread on top to declare
 * coverage:
 *
 * ```ts
 * const SLACK_MESSAGING_CAPABILITIES: MessagingCapabilities = {
 *   ...NO_MESSAGING_CAPABILITIES,
 *   entities: ['channel', 'message'],
 * };
 * ```
 */
export const NO_MESSAGING_CAPABILITIES: MessagingCapabilities = {
  entities: [],
};
