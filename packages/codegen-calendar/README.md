# @pattern-stack/codegen-calendar

The **L2 calendar surface package** for [`@pattern-stack/codegen`](https://www.npmjs.com/package/@pattern-stack/codegen).

A *surface package* ships the type-shaped vocabulary, **ports**, and **DI
tokens** for one integration surface — a swe-brain *bounded context* in
ADR-0006's vocabulary (ADR-036 §11.3). Here: `calendar` (entity `meeting`). The
package is named for the **context noun** (`calendar`), not the entity
(`meeting`) — the port stays entity-agnostic. The full rationale is in
**[ADR-036 — Surface packages](../../docs/adrs/ADR-036-surface-packages.md)**.

This surface is **far thinner than CRM**: it has no field/picklist/association
readers (that vocabulary is CRM-shaped). A calendar adapter is incremental-read
+ a canonical type — so the package ships exactly the canonical `Meeting`
vocabulary, the composing `CalendarPort`, a capability descriptor, and tokens.

## Layers

```
L1  @pattern-stack/codegen          — codegen subsystems (IChangeSource, IEntityChangeSourceRegistry, IAuthStrategy)
L2  @pattern-stack/codegen-calendar — THIS PACKAGE: CanonicalMeeting vocab + CalendarPort + tokens
L3  generated CalendarPort wiring   — composes auth + the change-source registry (Track D)
    consumer adapters               — implement the port per provider (Google, …)
```

## Exports

| Export | Kind |
|---|---|
| `CanonicalMeeting` | canonical type — the vendor-agnostic `T` a calendar adapter reads into (ADR-036 §7 vocabulary) |
| `CalendarCapabilities`, `NO_CALENDAR_CAPABILITIES` | per-adapter capability descriptor (entity coverage) |
| `CALENDAR_CAPABILITIES` | DI token (`Symbol.for`) |
| `CalendarPort` | L3 composing port — the contract an adapter implements (entity-agnostic) |
| `CALENDAR_PORT` | DI token (`Symbol.for`) |
| `assertCalendarAdapter` (from `@pattern-stack/codegen-calendar/testing`) | conformance helper |

```ts
import {
  type CanonicalMeeting,
  type CalendarPort,
  CALENDAR_PORT,
} from '@pattern-stack/codegen-calendar';
```

## The read primitive — `changeSources`, not a bespoke `pull`

`CalendarPort` composes the L1 `changeSources: Record<string, IChangeSource<unknown>>`
(the C6/C7 seam) — the per-entity change sources the adapter *contributes*, keyed
by entity name. Each entry resolves an `IChangeSource<CanonicalMeeting>` — the
generic L1 read with cursor-by-value. The surface aggregator (a surface-module
concern, not the adapter's) folds every provider's `changeSources` into the
`CALENDAR_ENTITY_SOURCES` registry (an `IEntityChangeSourceRegistry`) that
entity-agnostic consumers read at runtime. The port carries **no** entity-specific
`pull*` method. (The swe-brain prototype used a transitional flat
`pullEvents({ syncToken })` because L1 `IncrementalRead<T>` wasn't minted yet; the
codegen package skips that and uses the `changeSources` pattern directly,
consistent with `CrmPort`.)

Codegen reshapes the read body inside each `changeSources` entry to an
`IncrementalReadBase<CanonicalMeeting, ResolvedFilter[]>` subclass (RFC-0003) —
the enumerate/hydrate read primitive. The author fills only `enumerate` /
`hydrate` / `toCanonical`; the base owns streaming, filter-before-hydrate,
bounded-concurrency hydration, and per-ref cursor emission.

## The composing port — `CalendarPort`

```ts
export interface CalendarPort {
  readonly auth: IAuthStrategy;                                  // L1
  readonly changeSources: Record<string, IChangeSource<unknown>>; // L1
  readonly capabilities: CalendarCapabilities;                   // L2
}
```

Entity-agnostic — no entity name appears in its type. The adapter contributes
`changeSources['meeting']`; the surface aggregator folds every provider's
contributions into the entity-keyed `CALENDAR_ENTITY_SOURCES` registry that
consumers read at runtime. Per-consumer typed views are codegen-emitted
(Track D), not encoded here.

## Declaring capabilities

```ts
import {
  type CalendarCapabilities,
  NO_CALENDAR_CAPABILITIES,
} from '@pattern-stack/codegen-calendar';

export const GOOGLE_CALENDAR_CAPABILITIES: CalendarCapabilities = {
  ...NO_CALENDAR_CAPABILITIES,
  entities: ['meeting'],
};
```

## Conformance testing

```ts
import { assertCalendarAdapter } from '@pattern-stack/codegen-calendar/testing';

it('google calendar adapter conforms to CalendarPort', () => {
  assertCalendarAdapter(googleCalendarAdapter); // throws AggregateError listing every gap
});
```

Verifies the required L1 slots resolve and every `capabilities.entities` entry
has a registered `changeSources` entry — so an adapter declaring an entity it
can't source fails the test rather than failing at runtime.

## License

MIT
