/**
 * CRM L2 port — association reader (Track C · C3, #332).
 *
 * Reads cross-entity associations (contact ↔ account ↔ opportunity). Both
 * HubSpot (associations API) and Salesforce (lookup / master-detail
 * relationships) expose this. Read-side only — outbound association writes are
 * L1 sink territory + per-provider semantics (out of scope here).
 *
 * Ports only — the implementing class is consumer-side (ADR-036).
 */

import type { CrmEntity } from './field-definition-reader.port';

/**
 * The CRM entity set, under the C3 issue's `CrmEntityType` name. Aliased to the
 * canonical `CrmEntity` (C1) so the package has a single source of truth for
 * the union while both names resolve for consumers.
 */
export type CrmEntityType = CrmEntity;

/** One association edge between two CRM records. */
export interface CrmAssociation {
  fromEntity: CrmEntityType;
  fromId: string;
  toEntity: CrmEntityType;
  toId: string;
  /** Provider-specific association type (HubSpot association type id, SFDC relationship name). */
  associationType?: string;
  /** Optional cardinality hint — the primary related record, when the provider distinguishes one. */
  primary?: boolean;
}

/**
 * Reads associations from one record to related records of a target entity.
 */
export interface IAssociationReader {
  /**
   * List associations from a single record to all related records of a given
   * target entity.
   *
   * @param integrationId The connection / integration identifier.
   * @param fromEntity    The source record's entity.
   * @param fromId        The source record's provider id.
   * @param toEntity      The target entity to list related records of.
   */
  list(
    integrationId: string,
    fromEntity: CrmEntityType,
    fromId: string,
    toEntity: CrmEntityType,
  ): Promise<CrmAssociation[]>;
}
