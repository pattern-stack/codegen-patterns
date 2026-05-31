/**
 * CRM L2 port — picklist-value reader (Track C · C2, #331).
 *
 * Resolves the allowed values for a CRM picklist / multipicklist field. Both
 * HubSpot (enumerated property options) and Salesforce (Picklist field types
 * via `describeSObject`) expose this surface. Consumers typically call this
 * AFTER `IFieldDefinitionReader` returns a `picklist`/`multipicklist`
 * descriptor.
 *
 * Ports only — the implementing class is consumer-side (ADR-036).
 */

import type { CrmEntity } from './field-definition-reader.port';

/** One allowed value of a CRM picklist field. */
export interface CrmPicklistValue {
  /** Wire value (the value stored/transmitted). */
  value: string;
  /** User-facing label. */
  label: string;
  /** Whether the value is currently active/selectable. */
  active: boolean;
  /** True if this is the field's default value. */
  defaultValue?: boolean;
}

/**
 * Reads picklist values for a `(entity, field)` pair from a provider.
 */
export interface IPicklistReader {
  /**
   * Resolve picklist values for a given (entity, field) pair. Call after
   * `IFieldDefinitionReader` surfaces a `picklist`/`multipicklist` field.
   *
   * @param integrationId The connection / integration identifier.
   * @param entity        The CRM entity owning the field.
   * @param fieldId       The provider field id / API name (the descriptor `id`).
   */
  values(
    integrationId: string,
    entity: CrmEntity,
    fieldId: string,
  ): Promise<CrmPicklistValue[]>;
}
