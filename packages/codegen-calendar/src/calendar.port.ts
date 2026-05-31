/**
 * Calendar L3 composing port.
 *
 * `CalendarPort` is the single contract a calendar provider adapter implements.
 * It composes L1 strategies (auth + the entity-keyed change-source registry)
 * plus the runtime capability descriptor. Unlike `CrmPort` it carries **no L2
 * sub-ports** — the calendar surface is incremental-read + a canonical type
 * (`CanonicalMeeting`), so the port is far thinner: reads go through the
 * registry, there is no field/picklist/association reader to compose.
 *
 * **Entity-agnostic by design** — no entity name appears in this type (the port
 * is named for the *context*, `calendar`, not the entity `meeting`; ADR-036
 * §11.3). Entity access goes through `sources.get<CanonicalMeeting>('meeting')`
 * at runtime; per-consumer typed views are codegen-emitted (Track D), not
 * encoded here.
 *
 * The L1 types are imported across the package boundary from
 * `@pattern-stack/codegen/subsystems` (the C6/C7 seam) — type-only, erased at
 * runtime; see the package tsconfig for in-workspace resolution.
 */

import type {
  IAuthStrategy,
  IEntityChangeSourceRegistry,
} from '@pattern-stack/codegen/subsystems';
import type { CalendarCapabilities } from './capabilities';

export interface CalendarPort {
  /** L1 — auth strategy resolving credentials for this provider. */
  readonly auth: IAuthStrategy;

  /** L1 — entity-keyed registry of change sources for this provider's calendar entities. */
  readonly sources: IEntityChangeSourceRegistry;

  /** L2 — runtime capability descriptor (entity coverage). */
  readonly capabilities: CalendarCapabilities;

  // Surface-only methods (calendar-specific) start empty: the port ships with
  // the L1 + canonical-type composition only and accretes a method here ONLY
  // when a consumer use case forces it.
}
