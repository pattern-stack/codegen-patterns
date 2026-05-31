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
 * The adapter contributes `changeSources['email']`; the surface aggregator folds
 * every provider's `changeSources` into the `<SURFACE>_ENTITY_SOURCES` registry
 * that consumers read at runtime (post-E0: the adapter holds the contributions,
 * not the registry — RFC-0002). Per-consumer typed views are codegen-emitted.
 *
 * The L1 types are imported across the package boundary from
 * `@pattern-stack/codegen/subsystems` (the C6/C7 seam) — type-only, erased at
 * runtime; see the package tsconfig for in-workspace resolution.
 */

import type {
  IAuthStrategy,
  IChangeSource,
} from '@pattern-stack/codegen/subsystems';
import type { MailCapabilities } from './capabilities';

export interface MailPort {
  /** L1 — auth strategy resolving credentials for this provider. */
  readonly auth: IAuthStrategy;

  /** L1 — per-entity change sources this adapter contributes, keyed by entity
   *  name; the surface aggregator folds these into the entity-keyed registry. */
  readonly changeSources: Record<string, IChangeSource<unknown>>;

  /** L2 — runtime capability descriptor (entity coverage). */
  readonly capabilities: MailCapabilities;

  // Surface-only methods (mail-specific) start empty: the port ships with the
  // L1 + canonical-type composition only and accretes a method here ONLY when a
  // consumer use case forces it.
}
