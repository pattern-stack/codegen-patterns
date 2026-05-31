/**
 * Mail L3 composing port.
 *
 * `MailPort` is the single contract a mail provider adapter implements. It
 * composes L1 strategies (auth + the entity-keyed change-source registry) plus
 * the runtime capability descriptor. Unlike `CrmPort` it carries **no L2
 * sub-ports** — the mail surface is incremental-read + a canonical type
 * (`CanonicalEmail`), so the port is far thinner: reads go through the registry,
 * there is no field/picklist/association reader to compose.
 *
 * **Entity-agnostic by design** — no entity name appears in this type (the port
 * is named for the *context*, `mail`, not the entity `email`; ADR-036 §11.3).
 * Entity access goes through `sources.get<CanonicalEmail>('email')` at runtime;
 * per-consumer typed views are codegen-emitted (Track D), not encoded here.
 *
 * The L1 types are imported across the package boundary from
 * `@pattern-stack/codegen/subsystems` (the C6/C7 seam) — type-only, erased at
 * runtime; see the package tsconfig for in-workspace resolution.
 */

import type {
  IAuthStrategy,
  IEntityChangeSourceRegistry,
} from '@pattern-stack/codegen/subsystems';
import type { MailCapabilities } from './capabilities';

export interface MailPort {
  /** L1 — auth strategy resolving credentials for this provider. */
  readonly auth: IAuthStrategy;

  /** L1 — entity-keyed registry of change sources for this provider's mail entities. */
  readonly sources: IEntityChangeSourceRegistry;

  /** L2 — runtime capability descriptor (entity coverage). */
  readonly capabilities: MailCapabilities;

  // Surface-only methods (mail-specific) start empty: the port ships with the
  // L1 + canonical-type composition only and accretes a method here ONLY when a
  // consumer use case forces it.
}
