/**
 * CRM surface capability descriptor (Track C · C4, #333).
 *
 * Each consumer adapter declares which CRM ports it implements and which
 * entities it serves. The consumer framework uses this for runtime gating
 * (e.g. "disable the Custom Fields UI for a provider that doesn't implement
 * `IFieldDefinitionReader`").
 *
 * `entities` is **runtime data**, not a type bound on the L3 `CrmPort` (epic
 * #328 locked decision #7 / ADR-036 §6): the port stays entity-agnostic, and
 * capabilities declare which consumer-defined entities a given adapter can
 * resolve. Consumers query at runtime — `caps.entities.includes('lead')`. C6's
 * `assertCrmAdapter()` checks each `entities` entry resolves via the change
 * source registry.
 */

export interface CrmCapabilities {
  /** Implements `IFieldDefinitionReader`. */
  fieldDefinitions: boolean;
  /** Implements `IPicklistReader`. */
  picklists: boolean;
  /** Implements `IAssociationReader`. */
  associations: boolean;
  /**
   * Consumer-defined entity names this adapter can resolve (runtime coverage,
   * not a type bound). e.g. `['account', 'contact', 'opportunity', 'lead']`.
   */
  entities: readonly string[];
  // Future ports get a boolean here as they ship.
}

/**
 * The empty capability set — no ports, no entities. Spread on top to declare
 * what an adapter supports:
 *
 * ```ts
 * const HUBSPOT_CRM_CAPABILITIES: CrmCapabilities = {
 *   ...NO_CRM_CAPABILITIES,
 *   fieldDefinitions: true,
 *   picklists: true,
 *   associations: true,
 *   entities: ['account', 'contact', 'opportunity'],
 * };
 * ```
 */
export const NO_CRM_CAPABILITIES: CrmCapabilities = {
  fieldDefinitions: false,
  picklists: false,
  associations: false,
  entities: [],
};
