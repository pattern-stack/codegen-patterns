/**
 * CRM L3 composing port (Track C · C6, #337).
 *
 * `CrmPort` is the single contract a CRM provider adapter implements. It
 * composes L1 strategies (auth + the per-entity change-source contributions) and
 * the L2 capability ports (fields / picklists / associations) plus the runtime
 * capability descriptor.
 *
 * **Entity-agnostic by design** — no specific entity name appears anywhere in
 * this type. The adapter contributes `changeSources[entityName]`; the surface
 * aggregator folds them into the registry consumers read at runtime (post-E0 —
 * RFC-0002). Per-consumer typed views are codegen-emitted by Track D (D3/D4).
 *
 * The L1 types (`IAuthStrategy`, `IChangeSource`) are imported across the
 * package boundary from `@pattern-stack/codegen/subsystems` — the first place
 * L2-imports-L1 is exercised. This is a type-only import (erased at runtime);
 * see the package tsconfig for in-workspace resolution and the codegen
 * `exports` map for the published resolution.
 */

import type {
  IAuthStrategy,
  IChangeSource,
} from '@pattern-stack/codegen/subsystems';
import type { IFieldDefinitionReader } from './field-definition-reader.port';
import type { IPicklistReader } from './picklist-reader.port';
import type { IAssociationReader } from './association-reader.port';
import type { CrmCapabilities } from '../capabilities';

export interface CrmPort {
  /** L1 — auth strategy resolving credentials for this provider. */
  readonly auth: IAuthStrategy;

  /** L1 — per-entity change sources this adapter contributes, keyed by entity
   *  name; the surface aggregator folds these into the entity-keyed registry. */
  readonly changeSources: Record<string, IChangeSource<unknown>>;

  /** L2 — custom-field discovery. */
  readonly fields: IFieldDefinitionReader;

  /** L2 — picklist values discovery. */
  readonly picklists: IPicklistReader;

  /** L2 — cross-entity association reads. */
  readonly associations: IAssociationReader;

  /** L2 — runtime capability descriptor (includes entity coverage). */
  readonly capabilities: CrmCapabilities;

  // Surface-only methods (CRM-specific) start empty: the port ships with the
  // L1+L2 composition only and accretes a method here ONLY when a consumer use
  // case in pattern-stack/integration-patterns forces it (epic #328 DoD).
}
