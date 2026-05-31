/**
 * CRM L2 port — field-definition reader (Track C · C1, #330).
 *
 * `IFieldDefinitionReader` is the type-shaped port a consumer implements to
 * expose a provider's CRM field metadata (standard + custom fields) to the
 * generated L3 `CrmPort` (C6). The vocabulary that shapes it — `CrmFieldType`,
 * `CrmFieldDescriptor`, the `account | contact | opportunity` entity set —
 * lives HERE in the CRM surface package, not in `@pattern-stack/codegen`
 * (ADR-036 §7: surface-specific type vocab is owned by the surface package).
 *
 * This package ships the port only. The implementing class is consumer-side
 * (tracked in `pattern-stack/integration-patterns`); nothing here implements it.
 */

/** Canonical CRM entities this surface serves. */
export type CrmEntity = 'account' | 'contact' | 'opportunity';

/**
 * Normalized CRM field type. Providers' native field types map onto this closed
 * vocabulary by the consumer's reader implementation. `unknown` is the explicit
 * escape hatch for a provider type with no canonical mapping (kept rather than
 * throwing, so a single unmapped field doesn't fail the whole listing).
 */
export type CrmFieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'picklist'
  | 'multipicklist'
  | 'reference'
  | 'unknown';

/** One field definition from a provider, normalized to the CRM vocab. */
export interface CrmFieldDescriptor {
  /** Provider field id / API name. */
  id: string;
  /** User-facing name. */
  label: string;
  /** Normalized field type. */
  type: CrmFieldType;
  /** Which CRM entity this field belongs to. */
  entity: CrmEntity;
  /** True for provider custom fields, false for standard fields. */
  custom: boolean;
  /**
   * Optional provider-specific extras — picklist values, string length,
   * reference target, etc. Deliberately untyped at this seam; downstream
   * readers (C2 `IPicklistReader`, C3 `IAssociationReader`) own the shaped
   * accessors.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Reads field definitions for a CRM entity from a provider connection.
 */
export interface IFieldDefinitionReader {
  /**
   * List field definitions for a given entity type from the provider.
   * Returns BOTH standard and custom fields; the consumer filters with
   * `descriptor.custom` when only custom fields are needed.
   *
   * @param integrationId The connection / integration identifier to read against.
   * @param entity        The CRM entity whose fields to list.
   */
  list(integrationId: string, entity: CrmEntity): Promise<CrmFieldDescriptor[]>;
}
